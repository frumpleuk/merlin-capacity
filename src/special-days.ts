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
import { readSnapshot } from "./db";
import { readExclusives, type ExclusivePackage } from "./discover";
import type { Env } from "./types";

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
    const av = VARIANT.test(a.name) ? 1 : 0;
    const bv = VARIANT.test(b.name) ? 1 : 0;
    if (av !== bv) return av - bv;
    if (a.capacity !== b.capacity) return b.capacity - a.capacity;
    return a.name.localeCompare(b.name);
  })[0];
}

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
  E?: OneOrMany<{ id?: string }>;
  CT?: OneOrMany<{ id?: string }>;
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
async function fetchPartnerPackages(ex: ExchangeConfig): Promise<PartnerPackage[]> {
  const perMerchant = await Promise.all(
    ex.merchantIds.map(async (merchantId) => {
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
        if (ct && event) out.push({ id: p.id, ct, name, event, merchantId });
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
): Promise<Record<string, Candidate>[]> {
  if (!ex) return [];
  const packages = await fetchPartnerPackages(ex);
  if (packages.length === 0) return [];
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
    fetchExchangeDates(park.exchange, product, start, end),
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
      if (publicDates.has(date)) continue; // on public sale
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

  const days: Record<string, SpecialDay> = {};
  for (const [date, candidates] of byDate) {
    const best = pickLabel(candidates);
    if (best) days[date] = best;
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
