import { queueParks, type ParkConfig } from "./config";
import type { Env } from "./types";

/* ── Ride reliability ─────────────────────────────────────────────────────────
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
 * excluded rather than buried in downtime. `coverage` is reported next to it so a
 * day where our own poller was out can be discounted instead of read as an outage.
 *
 * `unscheduled` only works where the backend publishes per-ride hours, which is
 * the four Attractions.io parks. Paulton's, Flamingo Land and Blackpool fall back
 * to the park window, so a ride there that genuinely opens at noon is charged the
 * morning against its availability. Their numbers are sound against each other
 * and over time; they just aren't comparable with a Merlin park's.
 *
 * `down` is split again, using the notices the day file now carries: a published
 * maintenance window is not a breakdown, and folding the two together makes a
 * ride that was taken out of service deliberately look catastrophically
 * unreliable. Notices only exist from 2026-09-29 onward (the projection kept just
 * the last one before that), so `noticed` is 0 for older days rather than wrong —
 * `notices_known` says which it is.
 */

/** Minutes, per ride, for one day. Compact tuple — this store holds every ride
 *  for every day for over a year, and the field names would dwarf the numbers.
 *  [scheduled, up, down, maintenance-of-that-down, each fault's duration]
 *
 *  The durations are kept rather than a count and a total, because MTTR is only
 *  honest as a median: fault length is heavily right-skewed and one six-hour
 *  outage drags a mean somewhere no actual failure ever was. The count is
 *  `durations.length`, and their sum is the repair time proper — which is NOT
 *  the same as `down`, since down also holds the stretch before a ride first
 *  opens, and waiting for opening is not repairing. */
export type RideDay = [number, number, number, number, number[]];

const SCHEDULED = 0;
const UP = 1;
const DOWN = 2;
const MAINT = 3;
const FAULT_MINS = 4;

export interface DailyRollup {
  /** Park opening window that day, minutes since UTC midnight. */
  open: number;
  close: number;
  /** Fraction of the day's 10-minute buckets in which ANY ride in the park
   *  posted a sample. A live park moves somewhere every few minutes, so this
   *  sits near 1; a dip means OUR poller was out, which is the one failure that
   *  would otherwise read as the whole park breaking at once. */
  coverage: number;
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
  generated_at: string;
  /** Ride id → display name, so the summary needn't re-read a day file. */
  names: Record<string, string>;
  /** Ride id → the park's own grouping ("Top Thrills"). */
  groups: Record<string, string>;
  days: Record<string, DailyRollup>;
}

/** Keep a bit over a year, so a 365-day window is always whole and the store
 *  stays one modest object rather than a growing pile of per-day keys. */
const RETAIN_DAYS = 400;

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
  named?: boolean;
  open?: number;
  close?: number;
  lines: DayLine[];
}

interface QueueDayFile {
  park: string;
  date: string;
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

/** A notice that means the ride was taken out of service on purpose, as opposed
 *  to one promising it back ("Scheduled to open at 11:00" is a ride that is
 *  currently broken and being optimistic). */
const isMaintenance = (note: string) => /maintenance/i.test(note);

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
  faultMins: number[];
  /** Did the day produce any observation at all for this line? */
  observed: boolean;
} {
  const none = { up: 0, down: 0, maint: 0, faultMins: [] as number[], observed: false };
  if (to <= from) return none;
  if (!line || line.samples.length === 0) {
    // Nothing at all today. With delta logging that is indistinguishable from a
    // ride that is simply not in service this part of the season — half of
    // Blackpool in late September — so it is NOT counted as downtime unless the
    // park said why. A stated closure is a real closure and counts in full.
    const stated = line?.closedNote != null;
    if (!stated) return none;
    return {
      up: 0,
      down: to - from,
      maint: isMaintenance(line.closedNote!) ? to - from : 0,
      faultMins: [],
      observed: true,
    };
  }

  const inWindow = line.samples.filter((s) => s[0] < to);
  let up = 0;
  let down = 0;
  let faults = 0;
  const faultMins: number[] = [];
  // State before the first sample: not running (see above).
  let at = from;
  let running = false;
  let faultStart = from;
  // A fault is a ride that WAS running and stopped. The stretch before it first
  // opens is downtime, but calling it a fault would score every ride one failure
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
    if (running && !nowRunning) faultStart = t;
    if (!running && nowRunning && everRan && t > faultStart) {
      // A fault counts once it ends — an outage still open at close is counted
      // below, so nothing is double-counted or dropped.
      faults++;
      faultMins.push(t - faultStart);
    }
    if (nowRunning) everRan = true;
    running = nowRunning;
  }
  if (to > at) {
    if (running) up += to - at;
    else down += to - at;
  }
  // Broke and never came back before close. Only a fault if it ran at all —
  // otherwise this is the closed-all-day case, already all downtime.
  if (!running && everRan && to > faultStart) {
    faults++;
    faultMins.push(to - faultStart);
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

  return { up, down, maint, faultMins, observed: true };
}

/* ── Building one day ─────────────────────────────────────────────────────── */

/** Attendance for a date: tickets taken against the day's yield. `capacity -
 *  available` is the event-level figure; `used` counts only the packages that
 *  product happens to send, so it reads about 2.5x low. */
async function readAttendance(
  bucket: R2Bucket,
  park: ParkConfig,
  date: string,
): Promise<number | undefined> {
  if (!park.products.some((p) => p.key === "main")) return undefined;
  const obj = await bucket.get(`calendar/${park.key}/main/${date.slice(0, 7)}.json`);
  if (!obj) return undefined;
  try {
    const f = (await obj.json()) as {
      days?: Record<string, { capacity?: number; available?: number }>;
    };
    const d = f.days?.[date];
    if (!d || d.capacity == null || d.available == null || d.capacity <= 0) return undefined;
    return Math.max(0, d.capacity - d.available);
  } catch {
    return undefined;
  }
}

/** Project one park-day into a rollup, or null when there's no day file (the
 *  park was shut, or never polled). */
export async function buildDay(
  env: Env,
  park: ParkConfig,
  date: string,
): Promise<DailyRollup | null> {
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
  let noticesKnown = false;
  const COVERAGE_BUCKET = 10; // minutes
  const sampledBuckets = new Set<number>();

  for (const r of f.rides) {
    // Unidentified catalog artifacts ("Ride 12345") aren't rides anyone queues
    // for, and they appear and vanish; they'd churn the series for no gain.
    if (r.named === false) continue;
    const line = mainLine(r);
    if (line?.notices) noticesKnown = true;
    for (const s of line?.samples ?? []) sampledBuckets.add(Math.floor(s[0] / COVERAGE_BUCKET));
    // The ride's own hours when the backend publishes them, else the park's.
    const from = Math.max(open, r.open ?? open);
    const to = Math.min(close, r.close ?? close);
    const scheduled = Math.max(0, to - from);
    if (scheduled === 0) continue;
    const w = walkLine(line, from, to);
    // An unobserved day is recorded as scheduled-but-nothing-known: up + down is
    // 0, so it drops out of every ratio on its own, and the count of such days
    // surfaces as `closed_days` rather than quietly vanishing.
    rides[String(r.id)] = w.observed
      ? [scheduled, w.up, w.down, w.maint, w.faultMins]
      : [scheduled, 0, 0, 0, []];
  }
  if (Object.keys(rides).length === 0) return null;

  const attendance = await readAttendance(env.BUCKET, park, date);
  return {
    open,
    close,
    coverage: Math.min(
      1,
      sampledBuckets.size / Math.max(1, Math.ceil((close - open) / COVERAGE_BUCKET)),
    ),
    notices_known: noticesKnown,
    ...(attendance != null ? { attendance } : {}),
    rides,
  };
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

export interface RideStats {
  id: string;
  name: string;
  group?: string;
  /** Pooled: total up / total scheduled-and-known across the window. Weighted by
   *  day length, unlike a mean of daily rates — an 11-hour Saturday should not
   *  count the same as a 4-hour Tuesday. */
  availability: number | null;
  /** Median of the per-day rates: the typical day, unmoved by one 0% disaster. */
  median_day: number | null;
  /** The bad-day figure — one day in ten is this or worse. */
  p10_day: number | null;
  /** Scheduled minutes per fault. Higher is better. */
  mtbf: number | null;
  /** MEDIAN minutes to recover, not the mean: the distribution is heavily right-
   *  skewed and a single long outage drags a mean somewhere unrepresentative.
   *  This is the number that separates rides breaking equally often — Samurai and
   *  Rush both broke 1.9x/day over 61 days, and the gap between 83% and 92%
   *  availability was entirely how long each stayed broken. */
  mttr: number | null;
  /** The long tail of the same: one recovery in ten takes at least this. */
  mttr_p90: number | null;
  faults: number;
  /** Days with no fault at all, as a fraction of the days it ran — the figure
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

export interface WindowStats {
  days: number;
  /** Pooled across every ride: the park's own availability. */
  availability: number | null;
  /** Across rides, floored — closer to what a visit feels like than the mean. */
  geometric_mean: number | null;
  gm_floor: number;
  /** Mean of the parks' daily coverage; low means WE were out, not the park. */
  coverage: number;
  notices_known_days: number;
  rides: RideStats[];
}

export interface SummaryFile {
  park: string;
  generated_at: string;
  /** Inclusive bounds of the underlying daily store. */
  from: string;
  to: string;
  windows: Record<string, WindowStats>;
}

const WINDOWS = [7, 28, 90] as const;

function statsFor(store: DailyStore, dates: string[]): WindowStats {
  const ids = new Set<string>();
  for (const d of dates) for (const id of Object.keys(store.days[d].rides)) ids.add(id);

  let coverage = 0;
  let noticeDays = 0;
  for (const d of dates) {
    coverage += store.days[d].coverage;
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
    const faultMins: number[] = [];
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
      faultMins.push(...r[FAULT_MINS]);
      if (store.days[d].notices_known) maintKnown = true;
      const known = r[UP] + r[DOWN];
      // A day with nothing observed is neither clean nor faulty — the ride was
      // not in service, and calling that a fault-free day would flatter it.
      if (known === 0) {
        closedDays++;
        continue;
      }
      if (r[FAULT_MINS].length === 0) cleanDays++;
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
    const faults = faultMins.length;
    rides.push({
      id,
      name: store.names[id] ?? `Ride ${id}`,
      ...(store.groups[id] ? { group: store.groups[id] } : {}),
      availability: known > 0 ? up / known : null,
      median_day: median(dayRates),
      p10_day: percentile(dayRates, 10),
      mtbf: faults > 0 ? sched / faults : null,
      mttr: median(faultMins),
      mttr_p90: percentile(faultMins, 90),
      faults,
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
    coverage: dates.length ? coverage / dates.length : 0,
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
      generated_at: s.generated_at ?? "",
      names: s.names ?? {},
      groups: s.groups ?? {},
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
  maxNew = 40,
): Promise<number> {
  const store = (await readStore(env.BUCKET, park.key)) ?? {
    park: park.key,
    generated_at: "",
    names: {},
    groups: {},
    days: {},
  };

  // Yesterday backwards: today is still running, so it would be rewritten every
  // day and would drag every window's average down until the park closed.
  const wanted: string[] = [];
  for (let i = 1; i <= RETAIN_DAYS && wanted.length < maxNew; i++) {
    const d = ymd(now - i * 86_400_000);
    if (!store.days[d]) wanted.push(d);
  }

  let added = 0;
  for (const date of wanted) {
    const day = await buildDay(env, park, date);
    // A park that was shut has no day file; record nothing and don't retry it
    // forever — the loop above only looks back RETAIN_DAYS, so it ages out.
    if (!day) continue;
    store.days[date] = day;
    added++;
  }

  // Ride names/groups from the most recent day file we have, so a renamed ride
  // reads by its current name everywhere.
  const latest = Object.keys(store.days).sort().pop();
  if (latest) {
    const obj = await env.BUCKET.get(`queues/${park.key}/${latest}.json`);
    if (obj) {
      try {
        const f = (await obj.json()) as QueueDayFile;
        for (const r of f.rides ?? []) {
          if (r.named === false) continue;
          store.names[String(r.id)] = r.name;
          if (r.group) store.groups[String(r.id)] = r.group;
        }
      } catch {
        /* keep the names we have */
      }
    }
  }

  // Trim to the retention window so the store can't grow without bound.
  const cutoff = ymd(now - RETAIN_DAYS * 86_400_000);
  for (const d of Object.keys(store.days)) if (d < cutoff) delete store.days[d];

  store.generated_at = new Date(now).toISOString();
  await env.BUCKET.put(dailyKey(park.key), JSON.stringify(store), {
    httpMetadata: { contentType: "application/json" },
  });

  const all = Object.keys(store.days).sort();
  if (all.length > 0) {
    const windows: Record<string, WindowStats> = {};
    for (const w of WINDOWS) {
      const from = ymd(now - w * 86_400_000);
      const dates = all.filter((d) => d >= from);
      if (dates.length) windows[`d${w}`] = statsFor(store, dates);
    }
    const summary: SummaryFile = {
      park: park.key,
      generated_at: store.generated_at,
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
export async function runReliability(env: Env, now: number): Promise<void> {
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
