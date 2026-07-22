export interface DayObs {
  capacity: number;
  available: number;
  used: number;
  packageIds: string;
  /** Was the public day ticket on general sale? False = open only via the
   *  annual-pass prebook anchor (autumn dates not yet on public sale). Undefined
   *  (RAP, or pre-feature history) means treat as on sale. */
  onSale?: boolean;
}

export interface ProductFile {
  park: string;
  product: string;
  generated_at: string;
  days: Record<string, DayObs>;
}

/** Fetch one product's precomputed file from R2 (via the Worker). Returns null
 *  if it's missing or empty — the poller may not cover this product yet. */
export async function loadProduct(
  park: string,
  product: string,
): Promise<ProductFile | null> {
  const r = await fetch(`/calendar/${park}/${product}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as ProductFile;
  return Object.keys(f.days || {}).length > 0 ? f : null;
}

/** One location's opening hours for a day, classified by the backend: `event`
 *  is set when the API's lastEntryTime field was actually a special-event name. */
export interface LocationHours {
  kind: string; // "themepark" | "waterpark" | "golf"
  name: string;
  hours: string;
  lastEntry?: string;
  event?: string;
}

/** One happening in a What's-On park's day lineup (Flamingo Land). `time` is a
 *  display range ("4pm - 11pm") or a single time, absent for all-day; `category`
 *  is the salient Tribe category. */
export interface DayEvent {
  name: string;
  time?: string;
  category?: string;
}

export interface HoursDay {
  locations: LocationHours[];
  event?: string; // the themepark's special event (or headline act), for the whole day
  events?: DayEvent[]; // full day lineup for an events-only park (no opening hours)
}

export interface HoursFile {
  park: string;
  generated_at: string;
  days: Record<string, HoursDay>;
}

/** One product's precomputed file for a single month ('YYYY-MM'). Same shape as
 *  the forward file; past months are frozen at each date's final value. */
export async function loadProductMonth(
  park: string,
  product: string,
  month: string,
): Promise<ProductFile | null> {
  const r = await fetch(`/calendar/${park}/${product}/${month}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as ProductFile;
  return Object.keys(f.days || {}).length > 0 ? f : null;
}

/** Inclusive list of 'YYYY-MM' months from `min` to `max`. */
function monthsBetween(min: string, max: string): string[] {
  const out: string[] = [];
  let [y, m] = min.split("-").map(Number);
  const [maxY, maxM] = max.split("-").map(Number);
  while (y < maxY || (y === maxY && m <= maxM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** A product's full history + forward window, merged from its per-month files
 *  across the index range. The forward file (`loadProduct`) is today→+365 only,
 *  so the heatmap uses this to also show past dates (frozen at their final
 *  value). Month files are edge-cached, and past months are frozen, so this is
 *  cheap to refetch. Returns null if no month in range has data. */
export async function loadProductRange(
  park: string,
  product: string,
  index: ParkIndex,
): Promise<ProductFile | null> {
  const files = await Promise.all(
    monthsBetween(index.minMonth, index.maxMonth).map((m) =>
      loadProductMonth(park, product, m),
    ),
  );
  const days: Record<string, DayObs> = {};
  let generated_at = "";
  for (const f of files) {
    if (!f) continue;
    Object.assign(days, f.days);
    if (f.generated_at > generated_at) generated_at = f.generated_at;
  }
  return Object.keys(days).length ? { park, product, generated_at, days } : null;
}

/** A park's opening hours for a single month ('YYYY-MM'). */
export async function loadHoursMonth(
  park: string,
  month: string,
): Promise<HoursFile | null> {
  const r = await fetch(`/calendar/${park}/hours/${month}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as HoursFile;
  return Object.keys(f.days || {}).length > 0 ? f : null;
}

export interface ParkIndex {
  minMonth: string; // 'YYYY-MM'
  maxMonth: string;
}

/** The range of months for which data exists — the calendar's nav bounds. */
export async function loadParkIndex(park: string): Promise<ParkIndex | null> {
  const r = await fetch(`/calendar/${park}/index.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as ParkIndex;
  return f.minMonth && f.maxMonth ? f : null;
}

/* ── Ride queue times ──────────────────────────────────────────────────────────
 *
 * One precomputed file per park per day, `queues/<park>/<YYYY-MM-DD>.json`,
 * projected from the D1 change log. Each ride's queue lines carry the day's
 * samples as compact tuples: [minsSinceUtcMidnight, wait|null, open]. */

/** [minutes since UTC midnight, posted wait (null when not reporting), open 0/1,
 *  operational 0/1]. `operational` may be absent in older files → treat as 1. */
export type QueueSample = [number, number | null, 0 | 1, (0 | 1)?];

export interface QueueLineSeries {
  queueLineId: number;
  type: string | null;
  label: string; // "Main", "Single Rider", …
  samples: QueueSample[];
  // The park's own closed notice, in effect as of the latest sample — a
  // scheduled opening ("Scheduled to open at 11:00") or a closure reason ("Under
  // maintenance", "Closed all day"). Set only on a closed line (see the backend
  // projection); the row shows it instead of a derived "Closed all day".
  closedNote?: string;
}

/** One grouping dimension a park offers (see QueueDayFile.groupDims). */
export interface GroupDim {
  key: string;
  label: string; // shown on the group-by toggle ("Thrill", "Area")
  by: "thrill" | "land"; // section styling: thrill-ranked+toned, or neutral land
}

export interface QueueRide {
  id: number;
  name: string;
  category?: number;
  group?: string; // the park's own grouping: thrill class or themed land (see QueueDayFile.groupBy)
  /** Group per dimension (dim key → group name) when the park offers >1 grouping
   *  (Paulton's: {thrill, area}). Single-grouping parks use `group` instead. */
  groups?: Record<string, string>;
  named?: boolean; // false → parent ride absent from the content bundle
  lines: QueueLineSeries[];
}

export interface QueueDayFile {
  park: string;
  date: string; // 'YYYY-MM-DD'
  generated_at: string;
  /** How `ride.group`s should be read: by thrill class (default, omitted) or by
   *  themed land ("land" — Legoland). Land sections get a neutral tone and
   *  alphabetical order rather than the thrill-first ranking. */
  groupBy?: "land";
  /** Grouping dimensions offered, when the park has more than one (Paulton's:
   *  Thrill + Area). The UI shows a toggle and reads `ride.groups[dim.key]`. */
  groupDims?: GroupDim[];
  /** Park opening window, minutes since UTC midnight (frames the sparkline
   *  x-axis). Absent when the day's opening times weren't captured. */
  open?: number;
  close?: number;
  rides: QueueRide[];
}

/** One park's queue history for a single day. Null if the file is missing or
 *  has no rides (park not queue-tracked, or no data captured that day). */
export async function loadQueueDay(
  park: string,
  date: string,
): Promise<QueueDayFile | null> {
  const r = await fetch(`/queues/${park}/${date}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as QueueDayFile;
  return f.rides && f.rides.length > 0 ? f : null;
}

export interface QueueIndex {
  minDate: string; // 'YYYY-MM-DD'
  maxDate: string;
}

/** The range of days for which queue data exists — the date-nav bounds. */
export async function loadQueueIndex(park: string): Promise<QueueIndex | null> {
  const r = await fetch(`/queues/${park}/index.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as QueueIndex;
  return f.minDate && f.maxDate ? f : null;
}

/* ── Poll status ───────────────────────────────────────────────────────────────
 * When each product was last checked, and when a change was last detected. */

export interface PollStatus {
  last_polled: string;
  last_changed: string | null;
}

/** Last-poll / last-change for one product ('main' | 'rap' | 'queues'). */
export async function loadPollStatus(
  park: string,
  product: string,
): Promise<PollStatus | null> {
  const r = await fetch(`/status/${park}/${product}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  return (await r.json()) as PollStatus;
}

/** Aggregate several products' status: latest poll + latest change across them. */
export function mergeStatus(statuses: (PollStatus | null)[]): PollStatus | null {
  const present = statuses.filter((s): s is PollStatus => !!s);
  if (present.length === 0) return null;
  const max = (vals: (string | null)[]) => {
    const xs = vals.filter((v): v is string => !!v).sort();
    return xs.length ? xs[xs.length - 1] : null;
  };
  return {
    last_polled: max(present.map((s) => s.last_polled)) ?? present[0].last_polled,
    last_changed: max(present.map((s) => s.last_changed)),
  };
}
