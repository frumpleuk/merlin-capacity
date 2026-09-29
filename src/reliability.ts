import { queueParks, type ParkConfig } from "./config";
import { noticeKind } from "./db";
import type { Env } from "./types";

/* ── Ride uptime ─────────────────────────────────────────────────────────
 *
 * How often a ride is actually available, derived once a day from the served
 * queue day files. No new upstream requests and no D1 reads: the day file is
 * already the projection of the delta log, it is never pruned, and every backend
 * produces the same shape, so one code path covers all seven parks.
 *
 * The modelling decision that matters is that **uptime and downtime are not
 * complements**. Every scheduled minute is one of:
 *
 *   up          the line was open and operational
 *   down        it was reported, and wasn't
 *   unscheduled outside the ride's OWN window — Ghost Train is a 12:00 ride, and
 *               counting 10:00-12:00 against it says it opened late 28 days in 28
 *   unknown     inside the window, but nothing is known (no day file at all)
 *
 * Availability is `up / (up + down)` — over SCHEDULED minutes, with `unscheduled`
 * excluded rather than buried in downtime. `activity` is reported next to it as a
 * caveat on how finely the day is resolved.
 *
 * `unscheduled` only works where the backend publishes per-ride hours, which is
 * the four Attractions.io parks. Paulton's, Flamingo Land and Blackpool fall back
 * to the park window, so a ride there that genuinely opens at noon is charged the
 * morning against its availability. Their numbers are sound against each other
 * and over time; they just aren't comparable with a Merlin park's.
 *
 * `down` is split again, using the notices the day file now carries: a published
 * maintenance window is not a stoppage, and folding the two together makes a
 * ride that was taken out of service deliberately look catastrophically
 * unreliable. Notices only exist from 2026-09-29 onward (the projection kept just
 * the last one before that), so `noticed` is 0 for older days rather than wrong —
 * `notices_known` says which it is.
 */

/** Minutes, per ride, for one day. Compact tuple — this store holds every ride
 *  for every day for over a year, and the field names would dwarf the numbers.
 *  [scheduled, up, down, maintenance-of-that-down, each outage's duration]
 *
 *  The durations are kept rather than a count and a total, because outage length
 *  is only honest as a median — it is heavily right-skewed, and one six-hour
 *  stoppage drags a mean somewhere no actual stoppage ever was — and because the
 *  whole set is what answers the rider's question of whether to hold their place
 *  in the queue (see `outage_survival`). The count is `durations.length`, and
 *  their sum is time lost mid-session, which is NOT the same as `down`: down
 *  also holds the stretch before a ride first opens, and a ride that hasn't
 *  opened yet has not stopped. */
export type RideDay = [number, number, number, number, number[]];

const SCHEDULED = 0;
const UP = 1;
const DOWN = 2;
const MAINT = 3;
const OUTAGE_MINS = 4;

/** A day's rollup plus the ride names that day carried. Names are harvested per
 *  day rather than from the newest file alone: a ride retired mid-window is in
 *  the store's history but absent from the latest catalog, and reading names
 *  only from the newest day leaves it in the table as "Ride 52460". */
export interface BuiltDay {
  day: DailyRollup;
  names: Record<string, string>;
  groups: Record<string, string>;
  /** Ride id → { dim: value } for the multi-dimension parks. */
  dimGroups: Record<string, Record<string, string>>;
  /** The dimensions this park offers, if it offers any. */
  dims?: GroupDim[];
}

export interface DailyRollup {
  /** Park opening window that day, minutes since UTC midnight. */
  open: number;
  close: number;
  /** Fraction of the day's 10-minute buckets in which ANY ride in the park
   *  CHANGED. It is not a measure of whether we polled: the log holds changes
   *  only, so a successful poll that found nothing moved writes nothing and a
   *  quiet park is indistinguishable from a missed one. Blackpool off-season
   *  manages 0.73 changes per ride-hour against Thorpe's 2.44 and scores 51%
   *  while its data may be complete. Read it as how finely the day is resolved,
   *  not as a gap. */
  activity: number;
  /** Did the day file carry the per-notice history? False for days projected
   *  before that shipped — their `maintenance` split is unknown, not zero. */
  notices_known: boolean;
  /** Tickets taken against the day's yield (`capacity - available`, NOT `used`,
   *  which counts only the packages we happened to ask through). Absent for the
   *  parks with no ticket product — Flamingo Land and Blackpool. */
  attendance?: number;
  rides: Record<string, RideDay>;
}

export interface DailyStore {
  park: string;
  /** Rollup schema this store's days were built at (see STORE_VERSION). */
  v?: number;
  /** While catching up to a new STORE_VERSION: the oldest day already rebuilt.
   *  Days older than this still hold what the previous version captured, and a
   *  later run works backwards from here. */
  v_from?: string;
  generated_at: string;
  /** Ride id → display name, so the summary needn't re-read a day file. */
  names: Record<string, string>;
  /** Ride id → the park's own single grouping ("Top Thrills"). */
  groups: Record<string, string>;
  /** Ride id → { dim: value }, for the parks that group on more than one axis
   *  (Paulton's by thrill AND by area). */
  dimGroups?: Record<string, Record<string, string>>;
  /** The dimensions this park offers, when it offers a choice. */
  dims?: GroupDim[];
  days: Record<string, DailyRollup>;
}

/** Keep a bit over a year, so a 365-day window is always whole and the store
 *  stays one modest object rather than a growing pile of per-day keys. */
const RETAIN_DAYS = 400;

/** Bump when a day's rollup gains something buildDay has to re-derive from the
 *  day file — grouping, say. The summary is recomputed from the store on every
 *  run, so anything `statsFor` derives needs no rebuild; this is only for what
 *  is captured while a day is BUILT and then stored.
 *
 *  2 = per-ride grouping axes (`dimGroups`, `dims`).
 *  3 = `coverage` renamed to `activity`, which it always was. */
const STORE_VERSION = 3;

export const dailyKey = (park: string) => `stats/${park}/daily.json`;
export const summaryKey = (park: string) => `stats/${park}/summary.json`;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/* ── The day file, as much of it as this needs ─────────────────────────────── */

interface DayLine {
  type: string | null;
  samples: [number, number | null, 0 | 1, (0 | 1)?][];
  closedNote?: string;
  notices?: [number, number, string][];
}

interface DayRide {
  id: number;
  name: string;
  group?: string;
  /** Multi-dimension grouping (Paulton's: thrill + area), keyed by dim. */
  groups?: Record<string, string>;
  named?: boolean;
  open?: number;
  close?: number;
  lines: DayLine[];
}

/** One grouping dimension a park offers, as the day file declares it. */
export interface GroupDim {
  key: string;
  label: string;
  by: string;
}

interface QueueDayFile {
  park: string;
  date: string;
  groupDims?: GroupDim[];
  /** Projection version. Absent (or 1) means the file predates per-line notices,
   *  so its maintenance and seasonal splits are unknown rather than zero. */
  v?: number;
  open?: number;
  close?: number;
  rides: DayRide[];
}

/** The line a ride's availability is judged on: its main physical queue. Single
 *  Rider and virtual lines come and go independently of whether the ride is
 *  running, so they'd add noise, not signal. */
function mainLine(r: DayRide): DayLine | undefined {
  return r.lines.find((l) => (l.type ?? "").includes("main")) ?? r.lines[0];
}

/** The ride was taken out of service on purpose, as opposed to a notice
 *  promising it back ("Scheduled to open at 11:00" is a ride that is down and
 *  being optimistic). Downtime, but downtime the park accounted for. */
const isMaintenance = (note: string) => noticeKind(note) === "maintenance";

/** The ride isn't running this part of the year and the park has said so —
 *  Alton's "Only Available on Scarefest Dates", "Seasonal Attraction Reopens
 *  2027", "Closed Today, Opens 02.10.2026". Not downtime at all: counting a
 *  winter against a ride is how Blackpool came out at 72.6% available. */
const isSeasonal = (note: string) => noticeKind(note) === "seasonal";

/** Total minutes of `[start, end)` runs overlapping `[from, to)`. */
function overlap(runs: [number, number][], from: number, to: number): number {
  let total = 0;
  for (const [s, e] of runs) total += Math.max(0, Math.min(e, to) - Math.max(s, from));
  return total;
}

/**
 * Walk one line's samples into minute totals over the ride's scheduled window.
 *
 * Delta logging means a sample is only written when the state CHANGES, so each
 * sample's state persists until the next one — including past the final sample to
 * the close, which is why a ride that broke at 16:00 and never came back counts
 * the rest of the day as down rather than as missing.
 *
 * The window before the first sample is `down`, not `unknown`: the park is shut
 * overnight, so a ride that runs at all posts its morning open-transition. A late
 * first sample is a ride that was closed until then (see the archive's note on
 * the same inference for the closed-all-day case).
 */
function walkLine(
  line: DayLine | undefined,
  from: number,
  to: number,
): {
  up: number;
  down: number;
  maint: number;
  outageMins: number[];
  /** Did the day produce any observation at all for this line? */
  observed: boolean;
} {
  const none = { up: 0, down: 0, maint: 0, outageMins: [] as number[], observed: false };
  if (to <= from) return none;
  if (!line || line.samples.length === 0) {
    // Nothing at all today. With delta logging that is indistinguishable from a
    // ride that is simply not in service this part of the season — half of
    // Blackpool in late September — so it is NOT counted as downtime unless the
    // park said why. A stated closure is a real closure and counts in full…
    const stated = line?.closedNote != null;
    if (!stated) return none;
    // …unless what the park said is that it's out for the season, which is the
    // opposite: an explicit "not running today", and nothing to hold against it.
    if (isSeasonal(line!.closedNote!)) return none;
    return {
      up: 0,
      down: to - from,
      maint: isMaintenance(line.closedNote!) ? to - from : 0,
      outageMins: [],
      observed: true,
    };
  }

  const inWindow = line.samples.filter((s) => s[0] < to);
  let up = 0;
  let down = 0;
  let outages = 0;
  const outageMins: number[] = [];
  // State before the first sample: not running (see above).
  let at = from;
  let running = false;
  let outageStart = from;
  // An outage is a ride that WAS running and stopped. The stretch before it first
  // opens is downtime, but calling it an outage would score every ride one failure
  // a day just for opening a minute after its scheduled time.
  let everRan = false;

  for (const s of inWindow) {
    const t = Math.max(from, Math.min(s[0], to));
    if (t > at) {
      if (running) up += t - at;
      else down += t - at;
    }
    at = t;
    // `operational` is absent in older files; treat it as 1 there (the field was
    // added later and its absence never meant "broken").
    const nowRunning = s[2] === 1 && (s[3] ?? 1) === 1;
    if (running && !nowRunning) outageStart = t;
    if (!running && nowRunning && everRan && t > outageStart) {
      // An outage counts once it ends — an outage still open at close is counted
      // below, so nothing is double-counted or dropped.
      outages++;
      outageMins.push(t - outageStart);
    }
    if (nowRunning) everRan = true;
    running = nowRunning;
  }
  if (to > at) {
    if (running) up += to - at;
    else down += to - at;
  }
  // Broke and never came back before close. Only an outage if it ran at all —
  // otherwise this is the closed-all-day case, already all downtime.
  if (!running && everRan && to > outageStart) {
    outages++;
    outageMins.push(to - outageStart);
  }

  // How much of that downtime the park had published a reason for.
  const maintRuns = (line.notices ?? [])
    .filter(([, , note]) => isMaintenance(note))
    .map(([s, e]) => [s, e] as [number, number]);
  // A notice still in effect at the last sample runs to the close: the projection
  // ends it at that sample and repeats it in `closedNote`, which is the signal.
  if (line.closedNote && isMaintenance(line.closedNote) && maintRuns.length) {
    maintRuns[maintRuns.length - 1][1] = to;
  }
  const maint = Math.min(down, overlap(maintRuns, from, to));

  // Seasonal stretches leave the denominator entirely — taking them out of
  // `down` does that, since availability is up / (up + down). A ride the park
  // has said is out for the season is not being measured while it is.
  const seasonalRuns = (line.notices ?? [])
    .filter(([, , note]) => isSeasonal(note))
    .map(([s, e]) => [s, e] as [number, number]);
  if (line.closedNote && isSeasonal(line.closedNote) && seasonalRuns.length) {
    seasonalRuns[seasonalRuns.length - 1][1] = to;
  }
  const seasonal = Math.min(down - maint, overlap(seasonalRuns, from, to));
  down -= Math.max(0, seasonal);

  return { up, down, maint, outageMins, observed: true };
}

/* ── Building one day ─────────────────────────────────────────────────────── */

/** Attendance for a date: tickets taken against the day's yield. `capacity -
 *  available` is the event-level figure; `used` counts only the packages that
 *  product happens to send, so it reads about 2.5x low. */
type MonthDays = Record<string, { capacity?: number; available?: number }>;

/** Month file cache for one rollup run. A cold store rebuilds ~70 days per park
 *  and each of them wants the same two or three month files; without this the
 *  run spends most of its subrequest budget re-reading them. */
export type AttendanceCache = Map<string, MonthDays | null>;

async function readAttendance(
  bucket: R2Bucket,
  park: ParkConfig,
  date: string,
  cache: AttendanceCache,
): Promise<number | undefined> {
  if (!park.products.some((p) => p.key === "main")) return undefined;
  const month = date.slice(0, 7);
  let days = cache.get(month);
  if (days === undefined) {
    days = null;
    const obj = await bucket.get(`calendar/${park.key}/main/${month}.json`);
    if (obj) {
      try {
        days = ((await obj.json()) as { days?: MonthDays }).days ?? null;
      } catch {
        days = null;
      }
    }
    cache.set(month, days);
  }
  const d = days?.[date];
  if (!d || d.capacity == null || d.available == null || d.capacity <= 0) return undefined;
  return Math.max(0, d.capacity - d.available);
}

/** Project one park-day into a rollup, or null when there's no day file (the
 *  park was shut, or never polled). */
export async function buildDay(
  env: Env,
  park: ParkConfig,
  date: string,
  cache: AttendanceCache = new Map(),
): Promise<BuiltDay | null> {
  const obj = await env.BUCKET.get(`queues/${park.key}/${date}.json`);
  if (!obj) return null;
  let f: QueueDayFile;
  try {
    f = (await obj.json()) as QueueDayFile;
  } catch {
    return null;
  }
  if (!Array.isArray(f.rides) || f.rides.length === 0) return null;

  // Without a park window there's no denominator worth quoting. Fall back to the
  // span the samples themselves cover, which is what the UI does for the axis.
  let open = f.open;
  let close = f.close;
  if (open == null || close == null) {
    const all = f.rides.flatMap((r) => mainLine(r)?.samples.map((s) => s[0]) ?? []);
    if (all.length === 0) return null;
    open = Math.min(...all);
    close = Math.max(...all);
  }
  if (close <= open) return null;

  const rides: Record<string, RideDay> = {};
  const names: Record<string, string> = {};
  const groups: Record<string, string> = {};
  const dimGroups: Record<string, Record<string, string>> = {};
  // Whether the day CAN tell us why a ride was shut, which is a property of how
  // the file was projected — not of whether anything happened to be shut. A day
  // with no notices in it looks identical to a day that couldn't record any,
  // and only the version separates them.
  const noticesKnown = (f.v ?? 1) >= 2;
  const ACTIVITY_BUCKET = 10; // minutes
  const sampledBuckets = new Set<number>();

  for (const r of f.rides) {
    // Unidentified catalog artifacts ("Ride 12345") aren't rides anyone queues
    // for, and they appear and vanish; they'd churn the series for no gain.
    if (r.named === false) continue;
    const line = mainLine(r);
    for (const s of line?.samples ?? []) sampledBuckets.add(Math.floor(s[0] / ACTIVITY_BUCKET));
    // The ride's own hours when the backend publishes them, else the park's.
    const from = Math.max(open, r.open ?? open);
    const to = Math.min(close, r.close ?? close);
    const scheduled = Math.max(0, to - from);
    if (scheduled === 0) continue;
    names[String(r.id)] = r.name;
    if (r.group) groups[String(r.id)] = r.group;
    if (r.groups) dimGroups[String(r.id)] = r.groups;
    const w = walkLine(line, from, to);
    // An unobserved day is recorded as scheduled-but-nothing-known: up + down is
    // 0, so it drops out of every ratio on its own, and the count of such days
    // surfaces as `closed_days` rather than quietly vanishing.
    rides[String(r.id)] = w.observed
      ? [scheduled, w.up, w.down, w.maint, w.outageMins]
      : [scheduled, 0, 0, 0, []];
  }
  if (Object.keys(rides).length === 0) return null;

  const attendance = await readAttendance(env.BUCKET, park, date, cache);
  const day: DailyRollup = {
    open,
    close,
    activity: Math.min(
      1,
      sampledBuckets.size / Math.max(1, Math.ceil((close - open) / ACTIVITY_BUCKET)),
    ),
    notices_known: noticesKnown,
    ...(attendance != null ? { attendance } : {}),
    rides,
  };
  return { day, names, groups, dimGroups, ...(f.groupDims ? { dims: f.groupDims } : {}) };
}

/* ── Windowed statistics ──────────────────────────────────────────────────── */

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Nearest-rank percentile, so the value returned is one that actually occurred. */
const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

/** Geometric mean, floored. One ride at 0% would otherwise zero a whole park's
 *  composite, which is too blunt: a park with nine good rides and one dead one
 *  should score badly, not infinitely badly. The floor is stated in the output
 *  so the number can't be mistaken for an unbounded one. */
const GM_FLOOR = 0.01;
function geometricMean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += Math.log(Math.max(GM_FLOOR, x));
  return Math.exp(sum / xs.length);
}

/**
 * The queue question: it has stopped, do you stay?
 *
 * `resume_within` is the unconditional answer — of all this ride's past
 * stoppages, the share over within 15, 30 and 60 minutes. The conditional pair
 * is the one that's actually useful once you're standing there, because waiting
 * changes the odds: a stoppage that has already run 30 minutes is drawn from the
 * long tail, so its REMAINING time is typically worse than the 30 you've done,
 * not better. `median_remaining_at_15` and `_at_30` are the median further wait
 * given it has already lasted that long.
 */
export interface OutageSurvival {
  resume_within_15: number;
  resume_within_30: number;
  resume_within_60: number;
  median_remaining_at_15: number | null;
  median_remaining_at_30: number | null;
  /** How many stoppages actually ran past each threshold — the subset those
   *  medians are computed over. Without it "10 minutes more" looks like it
   *  applies to every stoppage rather than to the ones still going. */
  n_past_15: number;
  n_past_30: number;
  /** How many past stoppages the whole thing is drawn from. */
  n: number;
}

/** Below this the survival curve is noise dressed as advice. */
const MIN_OUTAGES_FOR_SURVIVAL = 12;

/** Upper bound of each stoppage-length bin, in minutes; the last bin is open.
 *  Fixed rather than derived, so every ride and every park share an axis and the
 *  shapes can be compared by eye. Finer where the mass is: across 1,524 Thorpe
 *  stoppages the distribution is unimodal and peaks at 10-15 minutes, with a
 *  long thin tail out past four hours. */
export const OUTAGE_BINS = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

/** Counts per bin, length OUTAGE_BINS.length + 1 (the last is "longer"). */
function histogram(durations: number[]): number[] {
  const out = new Array<number>(OUTAGE_BINS.length + 1).fill(0);
  for (const d of durations) {
    let i = OUTAGE_BINS.findIndex((edge) => d < edge);
    if (i === -1) i = OUTAGE_BINS.length;
    out[i]++;
  }
  return out;
}

function survival(durations: number[]): OutageSurvival | null {
  const n = durations.length;
  if (n < MIN_OUTAGES_FOR_SURVIVAL) return null;
  const share = (t: number) => durations.filter((d) => d <= t).length / n;
  // Of the stoppages that were still going at `t`, how much longer did they run?
  const remainingAfter = (t: number): number | null => {
    const still = durations.filter((d) => d > t).map((d) => d - t);
    return still.length >= MIN_OUTAGES_FOR_SURVIVAL / 2 ? median(still) : null;
  };
  return {
    resume_within_15: share(15),
    resume_within_30: share(30),
    resume_within_60: share(60),
    median_remaining_at_15: remainingAfter(15),
    median_remaining_at_30: remainingAfter(30),
    n_past_15: durations.filter((d) => d > 15).length,
    n_past_30: durations.filter((d) => d > 30).length,
    n,
  };
}

export interface RideStats {
  id: string;
  name: string;
  group?: string;
  /** Multi-dimension grouping, keyed by dim (see SummaryFile.groupDims). */
  groups?: Record<string, string>;
  /** Pooled: total up / total scheduled-and-known across the window. Weighted by
   *  day length, unlike a mean of daily rates — an 11-hour Saturday should not
   *  count the same as a 4-hour Tuesday. */
  availability: number | null;
  /** Median of the per-day rates: the typical day, unmoved by one 0% disaster. */
  median_day: number | null;
  /** The bad-day figure — one day in ten is this or worse. */
  p10_day: number | null;
  /** Scheduled minutes per outage — how long it typically runs between
   *  stoppages. Higher is better. */
  minutes_between_outages: number | null;
  /** MEDIAN outage length, not the mean: the distribution is heavily right-
   *  skewed and a single long stoppage drags a mean somewhere unrepresentative.
   *  This is the number that separates rides stopping equally often — Samurai and
   *  Rush both stopped 1.9x/day over 61 days, and the gap between 83% and 92%
   *  availability was entirely how long each stayed down. */
  outage_median: number | null;
  /** The long tail of the same: one stoppage in ten lasts at least this. */
  outage_p90: number | null;
  outages: number;
  /** Stoppages per day it ran — the rate a rider actually meets. */
  outages_per_day: number | null;
  /** Whether to hold your place or walk away, from the distribution of past
   *  stoppages on this ride. Null until there are enough of them to mean
   *  anything (see MIN_OUTAGES_FOR_SURVIVAL). */
  outage_survival: OutageSurvival | null;
  /** The same stoppages as a histogram over OUTAGE_BINS — the shape behind the
   *  median and p90, which two rides can share while looking nothing alike. */
  outage_bins: number[] | null;
  /** Days with no outage at all, as a fraction of the days it ran — the figure
   *  that reads without explanation. */
  clean_days: number | null;
  /** Days the ride was listed on. */
  days: number;
  /** …of which it produced no observation at all and no stated reason: out of
   *  service rather than broken, so excluded from every rate above. */
  closed_days: number;
  /** Share of downtime the park had published a reason for. Null when no day in
   *  the window carried notices (i.e. all of it predates them). */
  maintenance_share: number | null;
  /** Downtime weighted by how many people were there to be let down. Null for a
   *  park with no ticket product. */
  guest_minutes_lost: number | null;
}

/** One day's park-level figure, so a particular visit can be put against the
 *  window it sits in — "was today bad, or is it always like this". */
export interface DailyPoint {
  date: string;
  /** Pooled across every ride that ran: the park's availability that day. */
  availability: number | null;
  /** Stoppages across the whole park, and rides that never ran at all. */
  outages: number;
  closed_rides: number;
  activity: number;
}

export interface WindowStats {
  days: number;
  /** Pooled across every ride: the park's own availability. */
  availability: number | null;
  /** Across rides, floored — closer to what a visit feels like than the mean. */
  geometric_mean: number | null;
  gm_floor: number;
  /** Mean of the days' `activity` — how much the park's waits moved, which
   *  bounds how finely anything here is resolved. Not a coverage figure; see
   *  DailyRollup.activity. */
  activity: number;
  /** Mean park opening minutes per day in the window. Lets a figure like
   *  "minutes between stoppages" be read in operating DAYS — 24h between stops
   *  is three eight-hour days, and reading it as one is the obvious trap. */
  open_minutes_mean: number;
  notices_known_days: number;
  /** Oldest first. Only on the widest window, since the shorter ones are its
   *  tail and repeating them would trivially double the file. */
  daily?: DailyPoint[];
  rides: RideStats[];
}

export interface SummaryFile {
  park: string;
  generated_at: string;
  /** The grouping axes this park offers, when it offers a choice. */
  groupDims?: GroupDim[];
  /** Inclusive bounds of the underlying daily store. */
  from: string;
  to: string;
  windows: Record<string, WindowStats>;
}

const WINDOWS = [7, 28, 90] as const;

/** The park's own figure for each day in the window. */
function dailySeries(store: DailyStore, dates: string[]): DailyPoint[] {
  return dates.map((d) => {
    const day = store.days[d];
    let up = 0;
    let known = 0;
    let outages = 0;
    let closed = 0;
    for (const r of Object.values(day.rides)) {
      const k = r[UP] + r[DOWN];
      if (k === 0) {
        closed++;
        continue;
      }
      up += r[UP];
      known += k;
      outages += r[OUTAGE_MINS].length;
    }
    return {
      date: d,
      availability: known > 0 ? up / known : null,
      outages,
      closed_rides: closed,
      activity: day.activity,
    };
  });
}

function statsFor(store: DailyStore, dates: string[]): WindowStats {
  const ids = new Set<string>();
  for (const d of dates) for (const id of Object.keys(store.days[d].rides)) ids.add(id);

  let activity = 0;
  let noticeDays = 0;
  let openMinutes = 0;
  for (const d of dates) {
    activity += store.days[d].activity;
    openMinutes += store.days[d].close - store.days[d].open;
    if (store.days[d].notices_known) noticeDays++;
  }

  const rides: RideStats[] = [];
  let parkUp = 0;
  let parkKnown = 0;
  for (const id of ids) {
    let up = 0;
    let down = 0;
    let maint = 0;
    let sched = 0;
    const outageMins: number[] = [];
    let guest = 0;
    let guestKnown = false;
    let maintKnown = false;
    let cleanDays = 0;
    let days = 0;
    let closedDays = 0;
    const dayRates: number[] = [];
    for (const d of dates) {
      const r = store.days[d].rides[id];
      if (!r) continue;
      days++;
      sched += r[SCHEDULED];
      up += r[UP];
      down += r[DOWN];
      maint += r[MAINT];
      outageMins.push(...r[OUTAGE_MINS]);
      if (store.days[d].notices_known) maintKnown = true;
      const known = r[UP] + r[DOWN];
      // A day with nothing observed is neither clean nor interrupted — the ride was
      // not in service, and calling that an outage-free day would flatter it.
      if (known === 0) {
        closedDays++;
        continue;
      }
      if (r[OUTAGE_MINS].length === 0) cleanDays++;
      dayRates.push(r[UP] / known);
      const att = store.days[d].attendance;
      if (att != null) {
        guest += r[DOWN] * att;
        guestKnown = true;
      }
    }
    const known = up + down;
    parkUp += up;
    parkKnown += known;
    const outages = outageMins.length;
    rides.push({
      id,
      name: store.names[id] ?? `Ride ${id}`,
      ...(store.groups[id] ? { group: store.groups[id] } : {}),
      ...(store.dimGroups?.[id] ? { groups: store.dimGroups[id] } : {}),
      availability: known > 0 ? up / known : null,
      median_day: median(dayRates),
      p10_day: percentile(dayRates, 10),
      minutes_between_outages: outages > 0 ? sched / outages : null,
      outage_median: median(outageMins),
      outage_p90: percentile(outageMins, 90),
      outages,
      outages_per_day: days - closedDays > 0 ? outages / (days - closedDays) : null,
      outage_survival: survival(outageMins),
      outage_bins: outages > 0 ? histogram(outageMins) : null,
      clean_days: days - closedDays > 0 ? cleanDays / (days - closedDays) : null,
      days,
      closed_days: closedDays,
      maintenance_share: maintKnown && down > 0 ? maint / down : null,
      guest_minutes_lost: guestKnown ? guest : null,
    });
  }
  rides.sort((a, b) => (a.availability ?? 1) - (b.availability ?? 1));

  return {
    days: dates.length,
    availability: parkKnown > 0 ? parkUp / parkKnown : null,
    // Only rides present for most of the window. A ride that appears for two
    // days — a soft launch, or one retired mid-window like Vortex — would
    // otherwise hit the floor and drag the whole park's composite with it.
    geometric_mean: geometricMean(
      rides
        .filter((r) => r.days >= dates.length / 2)
        .map((r) => r.availability)
        .filter((x): x is number => x != null),
    ),
    gm_floor: GM_FLOOR,
    activity: dates.length ? activity / dates.length : 0,
    open_minutes_mean: dates.length ? openMinutes / dates.length : 0,
    notices_known_days: noticeDays,
    rides,
  };
}

/* ── The daily job ────────────────────────────────────────────────────────── */

async function readStore(bucket: R2Bucket, park: string): Promise<DailyStore | null> {
  const obj = await bucket.get(dailyKey(park));
  if (!obj) return null;
  try {
    const s = (await obj.json()) as Partial<DailyStore>;
    if (!s.days) return null;
    return {
      park,
      v: s.v ?? 1,
      ...(s.v_from ? { v_from: s.v_from } : {}),
      generated_at: s.generated_at ?? "",
      names: s.names ?? {},
      groups: s.groups ?? {},
      dimGroups: s.dimGroups ?? {},
      ...(s.dims ? { dims: s.dims } : {}),
      days: s.days,
    };
  } catch {
    return null;
  }
}

/**
 * Roll up one park: add any days the store is missing, then rewrite the summary.
 *
 * Backfills rather than only doing yesterday, so a failed night heals itself and
 * the first run picks up everything the day files already hold. `maxNew` bounds
 * one invocation — the first run has months to chew through and the R2 gets are
 * the only real cost.
 */
export async function rollUpPark(
  env: Env,
  park: ParkConfig,
  now: number,
  // Enough to fill the whole retained history in one run on a cold start; in
  // steady state there is exactly one new day to add, so this bound only ever
  // bites on the first fill or after an outage.
  maxNew = 60,
): Promise<number> {
  const store = (await readStore(env.BUCKET, park.key)) ?? {
    park: park.key,
    v: STORE_VERSION,
    generated_at: "",
    names: {},
    groups: {},
    dimGroups: {},
    days: {},
  };

  // Yesterday backwards: today is still running, so it would be rewritten every
  // day and would drag every window's average down until the park closed.
  //
  // A store behind STORE_VERSION also re-derives days it already has, newest
  // first and bounded per run, because what changed is captured while a day is
  // built rather than computed from it. `v_from` is how far back that has got,
  // so a run resumes instead of redoing the recent end every night.
  const stale = (store.v ?? 1) < STORE_VERSION;
  const staleFrom = store.v_from ?? ymd(now);
  const wanted: string[] = [];
  for (let i = 1; i <= RETAIN_DAYS && wanted.length < maxNew; i++) {
    const d = ymd(now - i * 86_400_000);
    if (!store.days[d] || (stale && d < staleFrom)) wanted.push(d);
  }

  const attendanceCache: AttendanceCache = new Map();
  let added = 0;
  // Oldest first, so a ride that was renamed ends up under its CURRENT name:
  // later days overwrite earlier ones, and a ride missing from the newest file
  // still keeps whatever it was last called.
  for (const date of [...wanted].sort()) {
    const built = await buildDay(env, park, date, attendanceCache);
    // A park that was shut has no day file; record nothing and don't retry it
    // forever — the loop above only looks back RETAIN_DAYS, so it ages out.
    if (!built) continue;
    store.days[date] = built.day;
    Object.assign(store.names, built.names);
    Object.assign(store.groups, built.groups);
    Object.assign((store.dimGroups ??= {}), built.dimGroups);
    if (built.dims) store.dims = built.dims;
    added++;
  }

  // Trim to the retention window so the store can't grow without bound.
  const cutoff = ymd(now - RETAIN_DAYS * 86_400_000);
  for (const d of Object.keys(store.days)) if (d < cutoff) delete store.days[d];

  // How far the version catch-up has got. Once it passes the oldest day we
  // hold, the whole store is current and the marker goes away.
  if (stale) {
    const oldestWanted = wanted.length ? wanted[wanted.length - 1] : staleFrom;
    const oldestHeld = Object.keys(store.days).sort()[0] ?? oldestWanted;
    if (oldestWanted <= oldestHeld) {
      store.v = STORE_VERSION;
      delete store.v_from;
    } else {
      store.v_from = oldestWanted;
    }
  }

  store.generated_at = new Date(now).toISOString();
  await env.BUCKET.put(dailyKey(park.key), JSON.stringify(store), {
    httpMetadata: { contentType: "application/json" },
  });

  const all = Object.keys(store.days).sort();
  if (all.length > 0) {
    const windows: Record<string, WindowStats> = {};
    let widest = "";
    for (const w of WINDOWS) {
      const from = ymd(now - w * 86_400_000);
      const dates = all.filter((d) => d >= from);
      if (!dates.length) continue;
      windows[`d${w}`] = statsFor(store, dates);
      widest = `d${w}`;
    }
    // The day-by-day series rides on the widest window only: the shorter ones
    // are its tail, and repeating it three times would treble the file for
    // nothing the reader can't slice themselves.
    if (widest) {
      const from = ymd(now - Number(widest.slice(1)) * 86_400_000);
      windows[widest].daily = dailySeries(
        store,
        all.filter((d) => d >= from),
      );
    }
    const summary: SummaryFile = {
      park: park.key,
      generated_at: store.generated_at,
      ...(store.dims ? { groupDims: store.dims } : {}),
      from: all[0],
      to: all[all.length - 1],
      windows,
    };
    await env.BUCKET.put(summaryKey(park.key), JSON.stringify(summary), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  return added;
}

/** Every queue park, once a day. */
export async function runUptime(env: Env, now: number): Promise<void> {
  await Promise.all(
    queueParks().map(async (park) => {
      try {
        await rollUpPark(env, park, now);
      } catch (err) {
        console.error(`reliability rollup failed for ${park.key}:`, err);
      }
    }),
  );
}
