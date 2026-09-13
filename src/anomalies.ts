import { HORIZON_DAYS, type ParkConfig } from "./config";
import { readSnapshot } from "./db";
import type { DayObs, Env } from "./types";

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Dates where our model of a park contradicts itself.
 *
 * Every special-day rule in this project was found the same way: a human noticed
 * a day that looked wrong on the calendar and we worked backwards. That doesn't
 * scale past the season it was found in — package ids and names rotate, partners
 * come and go, and a rule that silently stops matching looks exactly like a park
 * with nothing unusual on.
 *
 * So this reports the contradictions rather than enumerating the causes. It adds
 * no queries: everything here is already in R2 (both product snapshots, the
 * hours months, and the special days we DID explain). Dates we already label are
 * excluded, so what's left is the part the model can't account for.
 */
export type AnomalyKind =
  /** Theme park open to the public, but nothing sellable. A season ticket under
   *  a name we don't know (Chessington's "Theme Park Entry Only" sells its
   *  Christmas dates) or a genuine off-sale run. */
  | "open_no_tickets"
  /** Theme park open, nothing sellable, and nothing booked anywhere either.
   *  A season announced before it goes on sale, rather than a channel we're
   *  missing: Alton publishes its Christmas dates from 2026-11-27 with no
   *  package and no bookings against any product. Split from the above so the
   *  report separates "look into this" from "wait". */
  | "open_unsold"
  /** No public theme-park hours, yet an allocation or real bookings. A private
   *  event we haven't identified. */
  | "closed_but_selling"
  /** Bookings against capacity 0 — the shape a private event reports in. */
  | "bookings_no_allocation"
  /** An allocation smaller than the park's usual pool, which is how a
   *  restricted-attendance day shows up. */
  | "reduced_allocation"
  /** Off public sale on a future date while carrying the FULL pool. The
   *  Fright Nights shape: the season sells under its own package name. */
  | "offsale_at_full_pool";

export interface AnomalyGroup {
  kind: AnomalyKind;
  /** What the contradiction is, in one line. */
  note: string;
  dates: string[];
  /** The numbers behind the first date, to start the investigation from. */
  sample: string;
}

export interface AnomaliesFile {
  park: string;
  generated_at: string;
  /** The park's normal full-day allocation (see derivePool). */
  pool?: number;
  /** Dates the hours calendar covers, so a reader can tell "not published yet"
   *  from "deliberately omitted". */
  hours_span?: [string, string];
  total: number;
  groups: AnomalyGroup[];
}

const NOTES: Record<AnomalyKind, string> = {
  open_no_tickets: "Theme park open and bookings exist, but no package we poll sells the date",
  open_unsold: "Theme park open, nothing sellable and nothing booked: likely not on sale yet",
  closed_but_selling: "No public theme-park hours, yet an allocation or real bookings",
  bookings_no_allocation: "Bookings recorded against capacity 0",
  reduced_allocation: "Allocation smaller than the park's usual pool",
  offsale_at_full_pool: "Off public sale on a future date while carrying the full pool",
};

/**
 * The park's normal full-day allocation, as the MODAL capacity across future
 * dates that are on public sale. Modal rather than max: a park runs most of its
 * season at one number (15,000 Thorpe, 18,000 Alton, 11,440 Chessington, 14,500
 * Legoland), and taking the mode ignores both the reduced private-event days and
 * any one-off larger event. Undefined when nothing is on sale to learn from.
 */
export function derivePool(snapshot: Record<string, DayObs>, today: string): number | undefined {
  const counts = new Map<number, number>();
  for (const [date, o] of Object.entries(snapshot)) {
    if (date <= today || o.onSale === false || !(o.capacity > 0)) continue;
    counts.set(o.capacity, (counts.get(o.capacity) ?? 0) + 1);
  }
  let best: { cap: number; n: number } | undefined;
  for (const [cap, n] of counts) {
    // Ties go to the larger capacity: the park pool, not a sub-allocation that
    // happens to appear on as many dates.
    if (!best || n > best.n || (n === best.n && cap > best.cap)) best = { cap, n };
  }
  return best?.cap;
}

/** Dates the hours calendar covers, and the subset where the theme park itself
 *  opens to the public. Mirrors special-days.ts: a park can publish waterpark
 *  and golf hours on a day the theme park is shut. */
async function readHours(
  bucket: R2Bucket,
  park: string,
  months: string[],
): Promise<{ all: Set<string>; themeparkOpen: Set<string> }> {
  const all = new Set<string>();
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
          all.add(iso);
          const tp = day.locations?.find((l) => l.kind === "themepark");
          if (tp?.hours && !/^closed$/i.test(tp.hours.trim())) themeparkOpen.add(iso);
        }
      } catch {
        /* ignore */
      }
    }),
  );
  return { all, themeparkOpen };
}

/** Dates we already explain, so they aren't reported as unexplained. */
async function readExplained(bucket: R2Bucket, park: string): Promise<Set<string>> {
  const obj = await bucket.get(`calendar/${park}/special.json`);
  if (!obj) return new Set();
  try {
    const f = (await obj.json()) as { days?: Record<string, unknown> };
    return new Set(Object.keys(f.days ?? {}));
  } catch {
    return new Set();
  }
}

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

const nums = (o?: DayObs) =>
  o ? `cap=${o.capacity} avail=${o.available} used=${o.used}` : "absent";

/**
 * Find the park's unexplained dates and write `status/<park>/anomalies.json`.
 * Runs after refreshSpecialDays so the days we DO explain are already excluded.
 * Never throws; on failure the previous file survives.
 */
export async function refreshAnomalies(
  env: Env,
  park: ParkConfig,
  now: number,
): Promise<number> {
  // accesso parks only. Paulton's is an independent source: a static
  // availability blob with no package/anchor model and a much shorter window
  // than its hours calendar, so every check here misreads it — it produced 232
  // findings, 211 of them "open but unsellable" for dates its blob simply
  // doesn't reach. Nothing to diagnose, so nothing to report.
  if (!park.merchantId || park.products.length === 0) return 0;
  const today = ymd(now);
  const end = ymd(now + HORIZON_DAYS * 86_400_000);

  const [main, rap, season, hours, explained] = await Promise.all([
    readSnapshot(env.BUCKET, park.key, "main"),
    readSnapshot(env.BUCKET, park.key, "rap"),
    // A season sold under its own package (Chessington Christmas). Its dates
    // report capacity 0 on `main` by design, so without it every one of them
    // reads as an unexplained booking against no allocation.
    readSnapshot(env.BUCKET, park.key, "season"),
    readHours(env.BUCKET, park.key, monthsBetween(today, end)),
    readExplained(env.BUCKET, park.key),
  ]);

  const pool = derivePool(main, today);
  const spanDates = [...hours.all].sort();
  const span: [string, string] | undefined = spanDates.length
    ? [spanDates[0], spanDates[spanDates.length - 1]]
    : undefined;

  const found = new Map<AnomalyKind, { dates: string[]; sample: string }>();
  const flag = (kind: AnomalyKind, date: string, sample: string) => {
    const g = found.get(kind);
    if (g) g.dates.push(date);
    else found.set(kind, { dates: [date], sample: `${date}: ${sample}` });
  };

  const dates = [
    ...new Set([
      ...Object.keys(main),
      ...Object.keys(rap),
      ...Object.keys(season),
      ...hours.all,
    ]),
  ].sort();
  for (const date of dates) {
    if (date <= today) continue; // the past reports differently and is settled
    if (explained.has(date)) continue; // already labelled
    const m = main[date];
    const r = rap[date];
    const se = season[date];
    const inSpan = !!span && date >= span[0] && date <= span[1];
    const sells = (o?: DayObs) => !!o && (o.capacity > 0 || o.used > 0);
    // Admission of any kind: a season product covers exactly the dates `main`
    // reports as capacity 0.
    const admits = sells(m) || sells(se);
    // Anyone at all holding a booking, across every product. Absence means the
    // day isn't on sale rather than sold through a channel we can't see.
    const booked = (m?.used ?? 0) + (se?.used ?? 0) + (r?.used ?? 0) > 0;

    // One finding per date, most specific first: a date that is open with
    // nothing to buy is not ALSO interesting for its allocation size.
    if (hours.themeparkOpen.has(date) && !admits) {
      flag(booked ? "open_no_tickets" : "open_unsold", date, `main ${nums(m)}, rap ${nums(r)}`);
    } else if (!hours.themeparkOpen.has(date) && inSpan && (admits || sells(r))) {
      flag("closed_but_selling", date, `main ${nums(m)}, rap ${nums(r)}`);
    } else if (m && m.capacity === 0 && m.used > 0 && !sells(se)) {
      flag("bookings_no_allocation", date, nums(m));
    } else if (m && pool && m.capacity > 0 && m.capacity < pool) {
      flag("reduced_allocation", date, `${nums(m)} vs pool ${pool}`);
    } else if (m && m.onSale === false && pool && m.capacity === pool) {
      flag("offsale_at_full_pool", date, nums(m));
    }
  }

  const groups: AnomalyGroup[] = [...found.entries()].map(([kind, g]) => ({
    kind,
    note: NOTES[kind],
    dates: g.dates,
    sample: g.sample,
  }));
  const total = groups.reduce((n, g) => n + g.dates.length, 0);

  const body: AnomaliesFile = {
    park: park.key,
    generated_at: new Date(now).toISOString(),
    ...(pool ? { pool } : {}),
    ...(span ? { hours_span: span } : {}),
    total,
    groups,
  };
  await env.BUCKET.put(`status/${park.key}/anomalies.json`, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  return total;
}
