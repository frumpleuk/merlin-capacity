import {
  EXCHANGE_ADDON_CLASSES,
  exchangeBootstrapUrl,
  HORIZON_DAYS,
  HOST,
  PARTNER_DAY_NAME,
  USER_AGENT,
  type ExchangeConfig,
  type ParkConfig,
  type ProductConfig,
} from "./config";
import { derivePool } from "./anomalies";
import { readSnapshot } from "./db";
import { readExclusives, resolvePackages, type ExclusivePackage } from "./discover";
import { writeSeasonNames } from "./season-names";
import type { DayObs, Env } from "./types";

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A day the theme park runs while closed to the general public — a corporate or
 * brand buyout. Thorpe, 2026-09-13: the opening-hours calendar skips the date
 * entirely, yet the live queue feed publishes waits all day and exactly one
 * ticket package sells it, "1 Day Pass - VodafoneThree Big Day Out". Alton,
 * 2026-11-05: the calendar lists the waterpark and golf but no theme park, and
 * only "1 Day Pass - Cadbury: Who will you take? 2026" sells the date.
 *
 * Naming the day matters because it's the one case where the queue charts have
 * no context: the calendar shows nothing, so a park full of 40-minute queues on
 * a "closed" day otherwise looks like a bug.
 */
export interface SpecialDay {
  /** The package name that identifies the day. */
  name: string;
  capacity: number;
  available: number;
  used: number;
}

export interface SpecialDaysFile {
  park: string;
  generated_at: string;
  days: Record<string, SpecialDay>;
}

/** Package names that describe HOW a ticket was bought, not WHAT the day is —
 *  discount variants, concession rates and redemptions. They sell alongside the
 *  real ticket on the same dates, so they're poor labels. Used only to rank
 *  candidates; a day whose only candidates are variants still counts, and falls
 *  back to the biggest allocation. */
const VARIANT = /offer|%\s*off|\boff\b|discount|student|concession|voucher|redemption|comp\b/i;

/** One candidate package's reading for a date. */
interface Candidate {
  name: string;
  capacity: number;
  available: number;
  used: number;
  /** From a class that IS an event, so it may name a date the prebook anchors
   *  also report (see EVENT_CLASSES and test 1 below). */
  eventClass?: boolean;
}

/**
 * The name that best describes the day, out of every package that sells it.
 * Prefers a non-variant name (the event ticket itself) over a discount variant,
 * then the largest allocation — a ring-fenced 100-seat bucket isn't the day's
 * identity. Ties break alphabetically so the label is stable across refreshes
 * rather than following object order.
 */
export function pickLabel(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort((a, b) => {
    // A class that IS the event names the day better than anything else can.
    if (!!a.eventClass !== !!b.eventClass) return a.eventClass ? -1 : 1;
    const av = VARIANT.test(a.name) ? 1 : 0;
    const bv = VARIANT.test(b.name) ? 1 : 0;
    if (av !== bv) return av - bv;
    if (a.capacity !== b.capacity) return b.capacity - a.capacity;
    return a.name.localeCompare(b.name);
  })[0];
}

/**
 * A day the park runs for passholders only.
 *
 * Not a guess at an unnamed day: it follows from the conditions the third source
 * already requires. `onSale === false` means every package that returned the
 * date was a yield anchor, and the anchors are passholder prebooks by definition
 * (`DiscoverSpec.anchorClassMatch`, "prebook") — Merlin's annual-pass prebooks,
 * and at Legoland its CLUB VIP Pass Prebook. So a real allocation with real
 * sales, on a day the theme park publishes no hours, sellable only through a
 * passholder prebook, IS a passholder event.
 *
 * Corroborated for Legoland 2026-11-08, which the park advertised on Facebook as
 * a Merlin passholders event. Kept unbranded because the anchors differ by park
 * (Legoland's CLUB VIP is not a Merlin pass).
 */
export const PASSHOLDER_EVENT = "Passholder event";

interface ApiDay {
  date?: string;
  T?: { capacity?: string; available?: string; used?: string };
}

/**
 * One package's sellable dates across the horizon. Queried ALONE — several
 * packages in one `P[]` merge into the most constrained allocation and the
 * per-package identity is lost (docs/accesso-api.md §3.1), which is the whole
 * signal here. Never throws; a failed package just contributes nothing.
 */
interface QueryContext {
  merchantId: string;
  origin: string;
}

async function fetchPackageDates(
  ctx: QueryContext,
  product: ProductConfig,
  pkg: ExclusivePackage,
  eventId: string,
  start: string,
  end: string,
): Promise<Record<string, Candidate>> {
  const body = {
    P: [{ CT: [{ id: pkg.ct, qty: 1 }], event_id: eventId, id: pkg.id }],
    extra_movie: product.extra_movie,
    identify_customer_types: 1,
    min_capacity: 0,
    version: "2",
    start_date: start,
    end_date: end,
    display_zero_capacity: "1",
    include_times: product.include_times,
    request_type: "GetMerchantPackageEventDates",
    _version: "6.31.6",
    application_id: "1500",
    merchant_id: ctx.merchantId,
    machine_id: "500",
    agent_id: "5",
    user_id: "5",
    device: "desktop",
    language: "en-gb",
  };
  let resp: Response;
  try {
    resp = await fetch(HOST, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "com-accessopassport-app-id": "1500",
        "com-accessopassport-client": "accesso26",
        "com-accessopassport-language": "en-gb",
        "com-accessopassport-merchant-id": ctx.merchantId,
        "content-type": "application/json;charset=UTF-8",
        origin: ctx.origin,
        referer: `${ctx.origin}/`,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return {};
  }
  if (!resp.ok) return {};
  let data: { SERVICE?: { status?: string; D?: ApiDay | ApiDay[] } };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    return {};
  }
  const svc = data.SERVICE ?? {};
  // FAILED just means this package is out of its validity window for the whole
  // range — routine for a seasonal ticket, not an error worth logging.
  if (svc.status !== "OK") return {};
  // `D` is a bare object when there's one date, an array when there are several.
  const raw = svc.D;
  const days = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const out: Record<string, Candidate> = {};
  for (const d of days) {
    const t = d?.T;
    if (!d?.date || !t) continue;
    const capacity = Number(t.capacity ?? 0);
    // Capacity 0 means the package lists the date but holds no allocation on it —
    // it isn't what makes the day sellable, so it can't name the day either.
    if (!(capacity > 0)) continue;
    out[d.date] = {
      name: pkg.name,
      capacity,
      available: Number(t.available ?? 0),
      used: Number(t.used ?? 0),
      ...(pkg.eventClass ? { eventClass: true } : {}),
    };
  }
  return out;
}

/** One-or-many, as accesso serves `E` / `CT`. */
type OneOrMany<T> = T | T[] | undefined;
const asArray = <T,>(v: OneOrMany<T>): T[] => (Array.isArray(v) ? v : v ? [v] : []);

interface ExchangePackage {
  id: string;
  name?: string;
  package_class?: string;
  /** Display strapline. Often names the partner where the package name doesn't
   *  ("Member Days - November" has "Exclusive for Blue Light Card and Defence
   *  Discount Service"), so it's the better label when it does. See partnerLabel. */
  headline?: string;
  E?: OneOrMany<{ id?: string }>;
  CT?: OneOrMany<{ id?: string }>;
}

/** The handful of HTML entities that turn up in a `headline`. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#174;?/g, "\u00ae")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "\u2019")
    .replace(/&ndash;/g, "\u2013");
}

/**
 * What to call a partner day.
 *
 * The package NAME is often the park's internal scheduling label rather than the
 * partner: Thorpe's Blue Light Card days are "Member Days - November", which
 * says nothing about who they're for. The `headline` usually does name them
 * ("Exclusive for Blue Light Card and Defence Discount Service"), so prefer it
 * whenever it actually mentions a partner, stripping the "Exclusive for" lead-in
 * that would otherwise start every label.
 *
 * It isn't reliable enough to use unconditionally. Alton's partner packages have
 * no headline at all, Thorpe's March one has the generic "Member discounts", and
 * Chessington's lists dates instead of a partner. In each of those the name is
 * the better label, so fall back to it.
 */
export function partnerLabel(pkg: { name?: string; headline?: string }): string {
  const name = (pkg.name ?? "").trim();
  const headline = decodeEntities((pkg.headline ?? "").trim());
  if (!headline || !PARTNER_DAY_NAME.test(headline)) return name;
  const stripped = headline.replace(/^exclusive(ly)?\s+for\s+/i, "").trim();
  return stripped || name;
}

/** A partner-day package, with the event it books against. Unlike the public
 *  merchant's packages these don't share one event, so each carries its own. */
interface PartnerPackage extends ExclusivePackage {
  event: string;
  /** Which of the park's exchange merchants this came from. */
  merchantId: string;
}

/**
 * A park's partner-day packages, across every exchange merchant it lists.
 * Read fresh each run: it is a handful of fetches a day, and needs no second
 * cache mechanism.
 *
 * Selected by NAME, not by class or event. Only Thorpe has a dedicated partner
 * event (532); everywhere else these sit on the park's main event among hundreds
 * of ordinary trade and discount packages, so nothing structural separates them.
 * Add-on classes are excluded because a partner name can land on one, as in
 * Legoland's "Adventure Golf - Blue Light Card".
 */
async function fetchPartnerPackages(
  ex: ExchangeConfig,
  merchantIds: string[],
): Promise<PartnerPackage[]> {
  const perMerchant = await Promise.all(
    merchantIds.map(async (merchantId) => {
      let resp: Response;
      try {
        resp = await fetch(exchangeBootstrapUrl(ex.bootstrapSlug, merchantId), {
          headers: {
            accept: "application/json, text/plain, */*",
            origin: ex.origin,
            referer: `${ex.origin}/`,
            "user-agent": USER_AGENT,
          },
        });
      } catch {
        return [];
      }
      if (!resp.ok) return [];
      let data: {
        GetMerchantPackageList?: { SERVICE?: { PS?: { P?: ExchangePackage[] } } };
      };
      try {
        data = (await resp.json()) as typeof data;
      } catch {
        return [];
      }
      const packages = data.GetMerchantPackageList?.SERVICE?.PS?.P;
      if (!Array.isArray(packages)) return [];

      const out: PartnerPackage[] = [];
      for (const p of packages) {
        const name = (p.name ?? "").trim();
        if (!PARTNER_DAY_NAME.test(name)) continue;
        if (EXCHANGE_ADDON_CLASSES.has(p.package_class ?? "")) continue;
        const ct = asArray(p.CT)
          .map((c) => c.id)
          .find((id): id is string => !!id);
        const event = asArray(p.E)
          .map((e) => e.id)
          .find((id): id is string => !!id);
        if (ct && event) {
          out.push({ id: p.id, ct, name: partnerLabel(p), event, merchantId });
        }
      }
      return out;
    }),
  );
  return perMerchant.flat();
}

/** What the opening-hours calendar says about the horizon. */
interface HoursCoverage {
  /** Every date any month file mentions, as [min, max]. A date outside this is
   *  one the calendar simply hasn't reached — absence there means "not published
   *  yet", never "closed". */
  span?: [string, string];
  /** Dates the THEME PARK itself opens to the public. Deliberately not "dates
   *  the calendar lists": Alton publishes waterpark and golf hours on its buyout
   *  days, so a date can be in the calendar with the theme park still shut. */
  themeparkOpen: Set<string>;
}

/** Read the park's opening-hours month files across the horizon. */
async function readHoursCoverage(
  bucket: R2Bucket,
  park: string,
  months: string[],
): Promise<HoursCoverage> {
  const all: string[] = [];
  const themeparkOpen = new Set<string>();
  await Promise.all(
    months.map(async (m) => {
      const obj = await bucket.get(`calendar/${park}/hours/${m}.json`);
      if (!obj) return;
      try {
        const f = (await obj.json()) as {
          days?: Record<string, { locations?: { kind?: string; hours?: string }[] }>;
        };
        for (const [iso, day] of Object.entries(f.days ?? {})) {
          all.push(iso);
          const tp = day.locations?.find((l) => l.kind === "themepark");
          if (tp?.hours && !/^closed$/i.test(tp.hours.trim())) themeparkOpen.add(iso);
        }
      } catch {
        /* ignore */
      }
    }),
  );
  all.sort();
  return {
    span: all.length ? [all[0], all[all.length - 1]] : undefined,
    themeparkOpen,
  };
}

/** Partner-day dates from the park's exchange merchants, or [] when it has none
 *  configured or the catalogs are unreachable. A package with no dated
 *  allocation answers FAILED and simply contributes nothing — every park but
 *  Thorpe is in that state today, their partner packages defined but dormant. */
async function fetchExchangeDates(
  ex: ExchangeConfig | undefined,
  product: ProductConfig,
  start: string,
  end: string,
  bucket: R2Bucket,
  parkKey: string,
  publicMerchantId: string,
  now: number,
): Promise<Record<string, Candidate>[]> {
  if (!ex) return [];
  // Configured ids first, plus anything a previous rescan healed to.
  const known = [...new Set([...ex.merchantIds, ...(await readExchangeIds(bucket, parkKey))])];
  let packages = await fetchPartnerPackages(ex, known);
  if (packages.length === 0) {
    // Every configured merchant has stopped yielding partner packages. Either
    // the park retired them or the ids moved; rescan the neighbourhood of the
    // PUBLIC merchant id, which is where they have always sat (105 -> 107,
    // 800 -> 805, 700 -> 700/704, 6400 -> 6407). Costs ~20 catalog fetches, so
    // it only ever runs on failure, never on the normal path.
    const healed = await rescanExchangeIds(ex, publicMerchantId);
    if (healed.length === 0) return [];
    await writeExchangeIds(bucket, parkKey, healed, now);
    packages = await fetchPartnerPackages(ex, healed);
    if (packages.length === 0) return [];
  }
  const out = await Promise.all(
    packages.map((pkg) =>
      fetchPackageDates(
        { merchantId: pkg.merchantId, origin: ex.origin },
        product,
        pkg,
        pkg.event,
        start,
        end,
      ),
    ),
  );
  return out.filter((r) => Object.keys(r).length > 0);
}

/** Every 'YYYY-MM' from `start`'s month through `end`'s, inclusive. */
function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const [y, m] = start.split("-").map(Number);
  for (let d = new Date(Date.UTC(y, m - 1, 1)); ; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const mk = d.toISOString().slice(0, 7);
    out.push(mk);
    if (mk >= end.slice(0, 7)) break;
  }
  return out;
}

/**
 * Find and name the park's buyout days, and write `calendar/<park>/special.json`.
 *
 * Two sources, both naming a date the public can't buy:
 *
 *   PUBLIC MERCHANT — the event's other day-ticket packages. A date qualifies on
 *   three tests: (1) such a package sells it with a real allocation but the
 *   public product doesn't, which comes off the main product's existing snapshot
 *   so it costs no extra query; (2) the theme park publishes no opening hours
 *   for it; and (3) it sits inside the span the hours calendar covers. All three
 *   are needed. Test 1 alone fires across a whole separately-ticketed season and
 *   on returns/compensation packages; test 2 alone can't tell a buyout from a
 *   routine midweek closure; without test 3 every far-future schools-group date
 *   qualifies, because "no hours" out there just means "not published yet".
 *
 *   EXCHANGE MERCHANTS — partner-day packages on the park's trade/reseller
 *   storefront, matched by name (see PARTNER_DAY_NAME). Tests 1 and 2 still
 *   apply, but NOT test 3: a package literally named for its partner, selling a
 *   date the public can't buy on a day with no theme-park hours, is a partner
 *   day wherever it falls, and these routinely fall past the end of the
 *   published calendar. Thorpe's 2026-11-06 John Lewis day and 2026-11-07/08
 *   Blue Light Card member days are all five or more days past the last date the
 *   hours calendar covers, so applying test 3 would discard every one.
 *
 * Off the hot path (its own daily cron): one request per package, and a park has
 * a few dozen. Never throws; on failure the previous file survives.
 */
export async function refreshSpecialDays(
  env: Env,
  park: ParkConfig,
  product: ProductConfig,
  now: number,
): Promise<number> {
  const eventId = product.discover?.event_id;
  if (!eventId) return 0;
  if (!park.merchantId || !park.origin) return 0;
  const exclusives = await readExclusives(env.BUCKET, park, product);
  if (exclusives.length === 0) return 0; // discovery hasn't run yet

  const start = ymd(now);
  const end = ymd(now + HORIZON_DAYS * 86_400_000);
  const publicCtx: QueryContext = { merchantId: park.merchantId, origin: park.origin };

  const [publicSnapshot, hours, results, exchangeResults] = await Promise.all([
    readSnapshot(env.BUCKET, park.key, product.key),
    readHoursCoverage(env.BUCKET, park.key, monthsBetween(start, end)),
    Promise.all(
      exclusives.map((pkg) => fetchPackageDates(publicCtx, product, pkg, eventId, start, end)),
    ),
    fetchExchangeDates(
      park.exchange,
      product,
      start,
      end,
      env.BUCKET,
      park.key,
      park.merchantId,
      now,
    ),
  ]);
  // Every public package failing means the API is down or the cached ids have
  // rotated. Keep the last good file rather than publishing an empty one — but
  // not when the exchange still answered, since that's real data to publish.
  if (
    results.every((r) => Object.keys(r).length === 0) &&
    exchangeResults.length === 0
  ) {
    return 0;
  }

  // Dates the public product sells. The main poll records a date only when a
  // package returned it, so presence here IS public availability.
  const publicDates = new Set(Object.keys(publicSnapshot));

  const byDate = new Map<string, Candidate[]>();
  const add = (date: string, cand: Candidate) => {
    const list = byDate.get(date);
    if (list) list.push(cand);
    else byDate.set(date, [cand]);
  };
  for (const res of results) {
    for (const [date, cand] of Object.entries(res)) {
      // Test 1, skipped for an event-class package. Legoland's "Passholder Day"
      // sells 2026-11-08 while the passholder prebook anchors report the same
      // date, which puts it in the public snapshot; a package in a class that
      // names the day outright should not lose to that.
      if (!cand.eventClass && publicDates.has(date)) continue;
      if (hours.themeparkOpen.has(date)) continue; // open to the public
      if (!hours.span || date < hours.span[0] || date > hours.span[1]) continue; // unpublished
      add(date, cand);
    }
  }
  // Exchange days skip the hours-span test (see the header): a dated allocation
  // on the partner event IS the evidence, and these days sit past the end of the
  // published calendar by design.
  for (const res of exchangeResults) {
    for (const [date, cand] of Object.entries(res)) {
      if (publicDates.has(date)) continue;
      if (hours.themeparkOpen.has(date)) continue;
      add(date, cand);
    }
  }

  // THIRD SOURCE: a date the main product DOES carry, with a real allocation and
  // real sales, on a day the theme park publishes no hours for. Legoland
  // 2026-11-08 is the case: 8,000 capacity rather than the usual 14,500, 4,138
  // sold, its own sold-out 599-seat RAP pool, and only golf hours published. The
  // two sources above both miss it because the prebook anchors put the date in
  // the public snapshot, so test 1 discards it before anything else runs.
  //
  // No package names it, but the conditions do: off public sale means only the
  // passholder prebook anchors returned the date, so it is a passholder event
  // (see PASSHOLDER_EVENT). Added LAST and only where no named candidate already
  // exists, so a real partner name always wins.
  for (const [date, obs] of Object.entries(publicSnapshot)) {
    if (byDate.has(date)) continue; // something named it already
    if (hours.themeparkOpen.has(date)) continue; // open to the public
    if (!hours.span || date < hours.span[0] || date > hours.span[1]) continue;
    if (!(obs.capacity > 0)) continue; // no allocation, so no evidence it ran
    if (obs.onSale !== false) continue; // still on public sale
    add(date, {
      name: PASSHOLDER_EVENT,
      capacity: obs.capacity,
      available: obs.available,
      used: obs.used,
    });
  }

  const days: Record<string, SpecialDay> = {};
  for (const [date, candidates] of byDate) {
    const best = pickLabel(candidates);
    if (best) days[date] = best;
  }

  // Learn this park's season-ticket names for discovery's next run (see the
  // section at the foot of this file). Never throws; a failure just leaves the
  // previous list in place.
  try {
    await deriveSeasonNames(
      env,
      park,
      product,
      eventId,
      publicCtx,
      exclusives,
      results,
      publicSnapshot,
      hours.themeparkOpen,
      start,
      now,
    );
  } catch {
    /* ignore */
  }

  // Published even when empty, so a buyout label doesn't linger once the day
  // passes out of the forward window.
  const body: SpecialDaysFile = {
    park: park.key,
    generated_at: new Date(now).toISOString(),
    days,
  };
  await env.BUCKET.put(`calendar/${park.key}/special.json`, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  return Object.keys(days).length;
}


/* ── Season tickets (deriving `alsoNames`) ─────────────────────────────────────
 *
 * A park can sell a whole season under its own package name rather than the
 * usual day ticket: Thorpe's Fright Nights is "Fright Nights Entry", Chessington
 * Christmas is "Theme Park Entry Only". When that name isn't in the product's
 * P[], every date in the season reports from the prebook anchors alone and reads
 * as passholder-only on the calendar, which was wrong on 24 Thorpe dates.
 *
 * Hardcoding the names doesn't survive the next season, so derive them. The
 * signature is precise: a day-ticket-class package, not the configured day
 * ticket, selling at the FULL park pool, on dates the theme park is open to the
 * public, that the public product can't currently sell.
 *
 * Adding a name to P[] is not automatically safe. The accesso merge reports the
 * most constrained allocation (docs §3.1), so a package that returns the date
 * with capacity 0 drags the merged figure to 0 — that is exactly why Chessington
 * can't be fixed this way. Each candidate is therefore VERIFIED against the live
 * API before it is adopted: query it alone, query it alongside the product's
 * real P[], and keep it only if the numbers match. */

/**
 * Spot season packages among the exclusives already queried, verify each is
 * merge-safe, and record the result for discovery to pick up on its next run.
 * Reuses `results` rather than re-querying; only the verification costs extra,
 * two requests per candidate, and candidates are rare.
 */
async function deriveSeasonNames(
  env: Env,
  park: ParkConfig,
  product: ProductConfig,
  eventId: string,
  ctx: QueryContext,
  exclusives: ExclusivePackage[],
  results: Record<string, Candidate>[],
  publicSnapshot: Record<string, DayObs>,
  themeparkOpen: Set<string>,
  today: string,
  now: number,
): Promise<number> {
  const pool = derivePool(publicSnapshot, today);
  if (!pool) return 0;

  const names: string[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (let i = 0; i < exclusives.length; i++) {
    const pkg = exclusives[i];
    const res = results[i];
    if (!res) continue;
    // Dates this package sells at the full pool, while the park is open to the
    // public and the product can't sell them.
    const season = Object.entries(res)
      .filter(([date, c]) => {
        if (date <= today || c.capacity !== pool) return false;
        if (!themeparkOpen.has(date)) return false;
        const cur = publicSnapshot[date];
        return !cur || cur.capacity === 0 || cur.onSale === false;
      })
      .map(([date]) => date)
      .sort();
    if (season.length === 0) continue;
    if (names.includes(pkg.name) || rejected.some((r) => r.name === pkg.name)) continue;

    // Verify on the first such date: alone, then alongside the real P[].
    const probe = season[0];
    const { P } = await resolvePackages(env.BUCKET, park, product);
    const [alone, merged] = await Promise.all([
      fetchPackageDates(ctx, product, pkg, eventId, probe, probe),
      fetchMergedCapacity(ctx, product, [...P, selector(pkg, eventId)], probe),
    ]);
    const want = alone[probe]?.capacity;
    if (!want) continue;
    if (merged === want) names.push(pkg.name);
    else {
      rejected.push({
        name: pkg.name,
        reason: `merge reports ${merged ?? "nothing"} against ${want} alone on ${probe}; needs its own product`,
      });
    }
  }

  if (names.length === 0 && rejected.length === 0) return 0;
  await writeSeasonNames(env.BUCKET, park.key, product.key, {
    generated_at: new Date(now).toISOString(),
    names: names.sort(),
    rejected,
  });
  return names.length;
}

const selector = (pkg: ExclusivePackage, eventId: string) => ({
  CT: [{ id: pkg.ct, qty: 1 }],
  event_id: eventId,
  id: pkg.id,
});

/** The merged capacity a whole P[] reports for one date, or undefined. */
async function fetchMergedCapacity(
  ctx: QueryContext,
  product: ProductConfig,
  P: unknown[],
  date: string,
): Promise<number | undefined> {
  const body = {
    P,
    extra_movie: product.extra_movie,
    identify_customer_types: 1,
    min_capacity: 0,
    version: "2",
    start_date: date,
    end_date: date,
    display_zero_capacity: "1",
    include_times: product.include_times,
    request_type: "GetMerchantPackageEventDates",
    _version: "6.31.6",
    application_id: "1500",
    merchant_id: ctx.merchantId,
    machine_id: "500",
    agent_id: "5",
    user_id: "5",
    device: "desktop",
    language: "en-gb",
  };
  let resp: Response;
  try {
    resp = await fetch(HOST, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "com-accessopassport-app-id": "1500",
        "com-accessopassport-client": "accesso26",
        "com-accessopassport-language": "en-gb",
        "com-accessopassport-merchant-id": ctx.merchantId,
        "content-type": "application/json;charset=UTF-8",
        origin: ctx.origin,
        referer: `${ctx.origin}/`,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return undefined;
  }
  if (!resp.ok) return undefined;
  try {
    const data = (await resp.json()) as { SERVICE?: { status?: string; D?: ApiDay | ApiDay[] } };
    const svc = data.SERVICE ?? {};
    if (svc.status !== "OK") return undefined;
    const raw = svc.D;
    const days = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const t = days.find((d) => d?.date === date)?.T;
    return t ? Number(t.capacity ?? 0) : undefined;
  } catch {
    return undefined;
  }
}


/* ── Exchange merchant ids ─────────────────────────────────────────────────────
 *
 * These are not derivable from the public id. Thorpe's is 105 -> 107, but
 * Alton's partner packages sit on 805 while 807 is a Fastrack-only catalog, and
 * Legoland splits across 700 and 704. So they are configured, and a rescan heals
 * them if they ever move.
 *
 * Rescanning eagerly would mean ~20 catalog fetches per park per run, several MB
 * each, to confirm something that changes maybe never. Instead the normal path
 * verifies them for free: if the configured ids yield no partner packages at
 * all, THAT is the signal to go looking. */

const exchangeKey = (park: string) => `catalog/${park}/exchange.json`;

async function readExchangeIds(bucket: R2Bucket, park: string): Promise<string[]> {
  const obj = await bucket.get(exchangeKey(park));
  if (!obj) return [];
  try {
    const f = (await obj.json()) as { merchantIds?: string[] };
    return Array.isArray(f.merchantIds) ? f.merchantIds : [];
  } catch {
    return [];
  }
}

async function writeExchangeIds(
  bucket: R2Bucket,
  park: string,
  merchantIds: string[],
  now: number,
): Promise<void> {
  await bucket.put(
    exchangeKey(park),
    JSON.stringify({
      generated_at: new Date(now).toISOString(),
      merchantIds,
      note: "Healed automatically: the configured exchange ids stopped yielding partner packages.",
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/** Scan ids around the park's public merchant and keep those whose catalog holds
 *  partner-named packages. Sequential in small batches: this is a recovery path,
 *  not a hot one, and each catalog is several MB. */
async function rescanExchangeIds(
  ex: ExchangeConfig,
  publicMerchantId: string,
): Promise<string[]> {
  const base = Number(publicMerchantId);
  if (!Number.isFinite(base)) return [];
  const candidates: string[] = [];
  for (let d = 0; d <= 10; d++) {
    if (d === 0) candidates.push(String(base));
    else candidates.push(String(base + d));
  }
  const found: string[] = [];
  for (const id of candidates) {
    const packages = await fetchPartnerPackages(ex, [id]);
    if (packages.length > 0) found.push(id);
  }
  return found;
}
