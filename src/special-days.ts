import { HORIZON_DAYS, HOST, USER_AGENT, type ParkConfig, type ProductConfig } from "./config";
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
async function fetchPackageDates(
  park: ParkConfig,
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
    merchant_id: park.merchantId,
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
        "com-accessopassport-merchant-id": park.merchantId ?? "",
        "content-type": "application/json;charset=UTF-8",
        origin: park.origin ?? "",
        referer: `${park.origin ?? ""}/`,
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
 * A date qualifies on three tests:
 *   1. some day-ticket package sells it with a real allocation, but the PUBLIC
 *      product doesn't (that comes straight off the main product's existing
 *      snapshot, so it costs no extra query);
 *   2. the theme park publishes no public opening hours for it; and
 *   3. it sits inside the span the hours calendar covers — beyond that, "no
 *      hours" means "not published yet", which would otherwise flag every
 *      far-future schools-group date.
 *
 * All three are needed. Test 1 alone fires across a whole separately-ticketed
 * season (Fright Nights) and on returns/compensation packages; test 2 alone
 * can't tell a buyout from a routine midweek closure.
 *
 * Off the hot path (its own daily cron): one request per exclusive package, and
 * a park has a few dozen. Never throws; on failure the previous file survives.
 */
export async function refreshSpecialDays(
  env: Env,
  park: ParkConfig,
  product: ProductConfig,
  now: number,
): Promise<number> {
  const eventId = product.discover?.event_id;
  if (!eventId) return 0;
  const exclusives = await readExclusives(env.BUCKET, park, product);
  if (exclusives.length === 0) return 0; // discovery hasn't run yet

  const start = ymd(now);
  const end = ymd(now + HORIZON_DAYS * 86_400_000);

  const [publicSnapshot, hours, results] = await Promise.all([
    readSnapshot(env.BUCKET, park.key, product.key),
    readHoursCoverage(env.BUCKET, park.key, monthsBetween(start, end)),
    Promise.all(
      exclusives.map((pkg) => fetchPackageDates(park, product, pkg, eventId, start, end)),
    ),
  ]);
  // Every package failing means the API is down or the cached ids have rotated —
  // keep the last good file rather than publishing an empty one.
  if (results.every((r) => Object.keys(r).length === 0)) return 0;

  // Dates the public product sells. The main poll records a date only when a
  // package returned it, so presence here IS public availability.
  const publicDates = new Set(Object.keys(publicSnapshot));

  const byDate = new Map<string, Candidate[]>();
  for (const res of results) {
    for (const [date, cand] of Object.entries(res)) {
      if (publicDates.has(date)) continue; // on public sale
      if (hours.themeparkOpen.has(date)) continue; // open to the public
      if (!hours.span || date < hours.span[0] || date > hours.span[1]) continue; // unpublished
      const list = byDate.get(date);
      if (list) list.push(cand);
      else byDate.set(date, [cand]);
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
