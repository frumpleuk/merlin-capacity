import { localInstant, parkDay, parkTimeZone, type ParkConfig } from "./config";
import { byMonth } from "./db";
import type { HoursDay } from "./hours";
import type { Env } from "./types";

/**
 * Weather from OpenWeather One Call 4.0 (docs/openweather-api.md), two streams:
 *
 *  - Through the day, for the Queues tab: `timeline/1h` from 07:00 park time,
 *    20 hourly records, rewritten every hour into `queues/<park>/weather/<date>.json`.
 *    Hours already gone are observations, the rest forecast, so the last write
 *    of a day is that day's record.
 *  - Day by day, for the Calendar: `timeline/1day` from yesterday, 10 days,
 *    merged into `calendar/<park>/weather/<YYYY-MM>.json`. Starting at yesterday
 *    rewrites the day just gone with what happened, replacing its forecast.
 *
 * Every call is billed past 1,000 a day, so every call goes through the daily
 * budget below. The hourly call goes only to parks open that day, from an hour
 * before they open to an hour after they close (callHours); the calendar's is
 * two calls a park every twelve hours. The rest drips into
 * backfilling days from before the key existed.
 */

const API = "https://api.openweathermap.org/data/4.0/onecall";

/** Calls a UTC day may spend, kept under the 1,000 free with room for a manual
 *  run or two. */
const DAILY_BUDGET = 900;
const BUDGET_KEY = "weather/budget.json";

/** First hour of the through-the-day window, park time. 20 records from 07:00
 *  run to 02:00, which covers every late opening before the 04:00 rollover. */
const DAY_START_HOUR = 7;

/** The calendar forecast is refreshed every this many hours (UTC). */
const DAILY_EVERY_H = 12;

/** One hour, in the queue files' time encoding (minutes since `${date}T00:00:00Z`). */
export interface WeatherHour {
  t: number;
  temp: number;
  feels?: number;
  /** Chance of precipitation, 0-1. */
  pop?: number;
  /** mm in the hour. */
  rain?: number;
  snow?: number;
  wind?: number;
  gust?: number;
  /** Direction the wind blows FROM, degrees clockwise from north. */
  deg?: number;
  clouds?: number;
  uvi?: number;
  /** OpenWeather condition code (2xx thunder … 8xx cloud). */
  id?: number;
  icon?: string;
  desc?: string;
  /** Forecast when written; absent once the hour has passed. */
  fc?: 1;
}

export interface WeatherDayFile {
  park: string;
  date: string;
  generated_at: string;
  hours: WeatherHour[];
}

/** One calendar day. */
export interface WeatherDay {
  min: number;
  max: number;
  pop?: number;
  rain?: number;
  snow?: number;
  wind?: number;
  gust?: number;
  deg?: number;
  id?: number;
  icon?: string;
  desc?: string;
  /** Forecast when written (the date was today or later). */
  fc?: 1;
}

/** The fields we read off a timeline record. The 4.0 docs list them but give no
 *  1h example, so every one is optional and the parser tolerates the 3.0 shapes
 *  too (`rain` as a number or as `{ "1h": n }`). */
interface OwmRecord {
  dt: number;
  temp?: number | { min?: number; max?: number; day?: number };
  feels_like?: number | Record<string, number>;
  pop?: number;
  rain?: number | Record<string, number>;
  snow?: number | Record<string, number>;
  wind_speed?: number;
  wind_gust?: number;
  wind_deg?: number;
  clouds?: number;
  uvi?: number;
  weather?: { id?: number; icon?: string; description?: string }[];
}

interface OwmTimeline {
  data?: OwmRecord[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const precip = (v: OwmRecord["rain"]): number | undefined =>
  typeof v === "number" ? v : v ? num(v["1h"] ?? v["1d"] ?? Object.values(v)[0]) : undefined;

/** The common fields, rounded and with zeros/absents dropped to keep files small. */
function common(r: OwmRecord) {
  const w = r.weather?.[0];
  const out: Partial<WeatherHour> = {};
  const pop = num(r.pop);
  if (pop != null) out.pop = Math.round(pop * 100) / 100;
  const rain = precip(r.rain);
  if (rain) out.rain = r1(rain);
  const snow = precip(r.snow);
  if (snow) out.snow = r1(snow);
  const wind = num(r.wind_speed);
  if (wind != null) out.wind = r1(wind);
  const gust = num(r.wind_gust);
  if (gust != null) out.gust = r1(gust);
  const deg = num(r.wind_deg);
  if (deg != null) out.deg = Math.round(deg);
  if (w?.id != null) out.id = w.id;
  if (w?.icon) out.icon = w.icon;
  if (w?.description) out.desc = w.description;
  return out;
}

export function parseHour(r: OwmRecord, date: string, nowMs: number): WeatherHour | null {
  const temp = num(r.temp);
  if (temp == null || !num(r.dt)) return null;
  const ms = r.dt * 1000;
  const h: WeatherHour = {
    t: Math.round((ms - Date.parse(`${date}T00:00:00Z`)) / 60_000),
    temp: r1(temp),
    ...common(r),
  };
  const feels = num(r.feels_like);
  if (feels != null) h.feels = r1(feels);
  const clouds = num(r.clouds);
  if (clouds != null) h.clouds = clouds;
  const uvi = num(r.uvi);
  if (uvi != null) h.uvi = r1(uvi);
  if (ms > nowMs) h.fc = 1;
  return h;
}

/** A daily record. `dt` is the park's local date written as UTC midnight
 *  (Tokyo's 23 October is 2026-10-23T00:00Z, with that morning's sunrise), so
 *  the UTC date of `dt` is the date, wherever the park is. */
export function parseDay(r: OwmRecord, today: string): [string, WeatherDay] | null {
  if (!num(r.dt) || typeof r.temp !== "object" || r.temp == null) return null;
  const min = num(r.temp.min);
  const max = num(r.temp.max);
  if (min == null || max == null) return null;
  const date = new Date(r.dt * 1000).toISOString().slice(0, 10);
  const d: WeatherDay = { min: r1(min), max: r1(max), ...common(r) };
  if (date >= today) d.fc = 1;
  return [date, d];
}

const localDateOf = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ── Budget ─────────────────────────────────────────────────────────────────── */

interface Budget {
  day: string;
  used: number;
}

async function readBudget(bucket: R2Bucket, nowMs: number): Promise<Budget> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const obj = await bucket.get(BUDGET_KEY);
  if (obj) {
    try {
      const b = (await obj.json()) as Budget;
      if (b.day === day) return b;
    } catch {
      // unreadable: start the day afresh
    }
  }
  return { day, used: 0 };
}

const writeBudget = (bucket: R2Bucket, b: Budget) =>
  bucket.put(BUDGET_KEY, JSON.stringify(b), { httpMetadata: { contentType: "application/json" } });

/** Thrown on a 429: the account's own cap is spent, so stop for the day. */
class QuotaSpent extends Error {}

async function fetchTimeline(
  env: Env,
  step: "1h" | "1day",
  park: ParkConfig,
  startMs: number,
): Promise<OwmRecord[]> {
  const { lat, lon } = park.weather!;
  const url =
    `${API}/timeline/${step}?lat=${lat}&lon=${lon}&units=metric` +
    `&start=${Math.floor(startMs / 1000)}&appid=${env.OPENWEATHER_KEY}`;
  const res = await fetch(url, { headers: { "user-agent": "dev-tool" } });
  if (res.status === 429) throw new QuotaSpent();
  if (!res.ok) throw new Error(`openweather ${step} ${park.key}: HTTP ${res.status}`);
  return ((await res.json()) as OwmTimeline).data ?? [];
}

/* ── Writers ────────────────────────────────────────────────────────────────── */

const dayKey = (park: string, date: string) => `queues/${park}/weather/${date}.json`;

async function writeDay(env: Env, park: ParkConfig, date: string, nowMs: number): Promise<number> {
  const tz = parkTimeZone(park);
  const records = await fetchTimeline(env, "1h", park, localInstant(date, DAY_START_HOUR, tz));
  const hours = records
    .map((r) => parseHour(r, date, nowMs))
    .filter((h): h is WeatherHour => h != null)
    .sort((a, b) => a.t - b.t);
  if (hours.length === 0) return 0;
  const file: WeatherDayFile = {
    park: park.key,
    date,
    generated_at: new Date(nowMs).toISOString(),
    hours,
  };
  await env.BUCKET.put(dayKey(park.key, date), JSON.stringify(file), {
    httpMetadata: { contentType: "application/json" },
  });
  // Daily records carry no gusts, so the calendar's comes from the hours.
  const gusts = hours.map((h) => h.gust).filter((g): g is number => g != null);
  if (gusts.length) await setDayGust(env.BUCKET, park.key, date, Math.max(...gusts), file.generated_at);
  return hours.length;
}

const monthKey = (park: string, date: string) => `calendar/${park}/weather/${date.slice(0, 7)}.json`;

/** Set one day's gust in its calendar month file, leaving the rest of the day as
 *  it is. A day the daily fetch hasn't reached yet gets an entry with the gust
 *  alone, which the calendar ignores until the rest arrives. */
function setDayGust(bucket: R2Bucket, park: string, date: string, gust: number, at: string) {
  const key = monthKey(park, date);
  return serialised(key, async () => {
    const cur = await readMonth(bucket, key);
    const days = { ...cur, [date]: { ...cur[date], gust } as WeatherDay };
    await putMonth(bucket, key, park, date.slice(0, 7), days, at);
  });
}

async function readMonth(bucket: R2Bucket, key: string): Promise<Record<string, WeatherDay>> {
  const obj = await bucket.get(key);
  if (!obj) return {};
  try {
    return ((await obj.json()) as { days?: Record<string, WeatherDay> }).days ?? {};
  } catch {
    return {};
  }
}

const putMonth = (
  bucket: R2Bucket,
  key: string,
  park: string,
  month: string,
  days: Record<string, WeatherDay>,
  at: string,
) =>
  bucket.put(key, JSON.stringify({ park, month, generated_at: at, days }), {
    httpMetadata: { contentType: "application/json" },
  });

/** Ten days from `from` into the calendar month files. */
async function writeDays(env: Env, park: ParkConfig, from: string, nowMs: number): Promise<number> {
  const tz = parkTimeZone(park);
  const today = localDateOf(nowMs, tz);
  // Same encoding as the records: the date's UTC midnight starts at that date.
  const records = await fetchTimeline(env, "1day", park, Date.parse(`${from}T00:00:00Z`));
  const days: Record<string, WeatherDay> = {};
  for (const r of records) {
    const p = parseDay(r, today);
    if (p && p[0] >= from) days[p[0]] = p[1];
  }
  const at = new Date(nowMs).toISOString();
  await Promise.all(
    [...byMonth(days)].map(([mk, ds]) => {
      const key = `calendar/${park.key}/weather/${mk}.json`;
      return serialised(key, async () => {
        const cur = await readMonth(env.BUCKET, key);
        // Each day is replaced whole (so a recorded day loses its forecast
        // fields), except the gust, which only the hourly fetch supplies.
        for (const [d, w] of Object.entries(ds)) {
          const gust = w.gust ?? cur[d]?.gust;
          cur[d] = gust != null ? { ...w, gust } : w;
        }
        await putMonth(env.BUCKET, key, park.key, mk, cur, at);
      });
    }),
  );
  return Object.keys(days).length;
}

/** Backfill runs several ten-day calls for one park at once, and neighbouring
 *  ones land in the same month file. Each merge is a read and a write, so they
 *  take turns per file or the last write drops the others' days. */
const fileQueue = new Map<string, Promise<unknown>>();
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (fileQueue.get(key) ?? Promise.resolve()).then(fn, fn);
  fileQueue.set(key, next.catch(() => {}));
  return next;
}

/* ── Jobs ───────────────────────────────────────────────────────────────────── */

const weatherParks = (parks: ParkConfig[]) => parks.filter((p) => p.weather);
/** Only parks with a Calendar tab get the day-by-day stream. */
const calendarParks = (parks: ParkConfig[]) =>
  weatherParks(parks).filter((p) => p.openingHours || p.products.length > 0);

/** The local hours, counted from the park day's midnight (25 is 01:00 the next
 *  morning), in which a park's hourly call is worth making: an hour either side
 *  of its opening times, so the day's file holds what happened while it was
 *  open. */
interface CallHours {
  from: number;
  to: number;
}

/** The whole through-the-day window: what a park whose times can't be read
 *  gets. */
const ALL_DAY: CallHours = { from: DAY_START_HOUR, to: DAY_START_HOUR + 19 };

/** "10am - 6pm", "9:30am - 5pm, 7pm - 11pm", "From 6:30pm" → the hours from
 *  the first opening to the last closing. A lone time is an opening with no
 *  close given, so the window runs to the end of the day. */
export function hoursSpan(text: string): CallHours | null {
  const times = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)].map(
    (m) => ((Number(m[1]) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0)) + Number(m[2] ?? 0) / 60,
  );
  if (!times.length) return null;
  const open = times[0];
  let close = times.length > 1 ? times[times.length - 1] : ALL_DAY.to;
  if (close <= open) close += 24; // past midnight
  return { from: open, to: close };
}

/** When a park's hourly call is worth making on `date`, or null if it's
 *  closed. Closed only when its hours month file says so: the date listed with
 *  every location closed, or left out by a source that lists open days only.
 *  No file, an events-only calendar (Flamingo Land), or times that don't parse
 *  get the whole day. */
async function callHours(bucket: R2Bucket, park: ParkConfig, date: string): Promise<CallHours | null> {
  if (!park.openingHours || park.openingHours.kind === "flamingoland") return ALL_DAY;
  const obj = await bucket.get(`calendar/${park.key}/hours/${date.slice(0, 7)}.json`);
  if (!obj) return ALL_DAY;
  const days = ((await obj.json().catch(() => null)) as { days?: Record<string, HoursDay> } | null)?.days;
  if (!days) return ALL_DAY;
  const open = (days[date]?.locations ?? []).filter((l) => !/closed/i.test(l.hours));
  if (!open.length) return null;
  const spans = open.map((l) => hoursSpan(l.hours));
  if (spans.some((x) => !x)) return ALL_DAY;
  return {
    from: Math.min(...spans.map((x) => x!.from)) - 1,
    to: Math.max(...spans.map((x) => x!.to)) + 1,
  };
}

/** A unit of work: one billed call. */
type Job = { label: string; run: () => Promise<unknown> };

/** Run jobs in order until the day's budget or the account's cap runs out.
 *  The budget is reserved before the calls go out, so a crash mid-run errs on
 *  the side of spending less. */
async function spend(env: Env, nowMs: number, jobs: Job[], reserve = 0): Promise<string[]> {
  const b = await readBudget(env.BUCKET, nowMs);
  const n = Math.max(0, Math.min(jobs.length, DAILY_BUDGET - reserve - b.used));
  if (n === 0) return [];
  b.used += n;
  await writeBudget(env.BUCKET, b);
  const done: string[] = [];
  let quotaSpent = false;
  await Promise.all(
    jobs.slice(0, n).map(async (j) => {
      if (quotaSpent) return;
      try {
        await j.run();
        done.push(j.label);
      } catch (err) {
        if (err instanceof QuotaSpent) quotaSpent = true;
        else console.error(`weather ${j.label}:`, err);
      }
    }),
  );
  if (quotaSpent) await writeBudget(env.BUCKET, { day: b.day, used: DAILY_BUDGET });
  return done;
}

/** The hourly run (its own cron, two minutes past): today's hours for every
 *  park, the calendar's ten days every twelve hours, and at 03:00 UTC whatever the
 *  rest of the day's budget can spare on backfill. */
export async function runWeather(env: Env, parks: ParkConfig[], scheduledTime: number): Promise<string[]> {
  if (!env.OPENWEATHER_KEY) return [];
  const hour = new Date(scheduledTime).getUTCHours();
  const wp = weatherParks(parks);
  const cp = calendarParks(parks);

  const dated = wp.map((p) => ({ p, date: parkDay(scheduledTime, parkTimeZone(p)) }));
  const windows = await Promise.all(dated.map(({ p, date }) => callHours(env.BUCKET, p, date)));
  const jobs: Job[] = dated
    .filter(({ p, date }, i) => {
      const w = windows[i];
      if (!w) return false;
      const local = (scheduledTime - localInstant(date, 0, parkTimeZone(p))) / 3_600_000;
      return local >= w.from && local <= w.to;
    })
    .map(({ p, date }) => ({ label: `${p.key}/${date}`, run: () => writeDay(env, p, date, scheduledTime) }));
  if (hour % DAILY_EVERY_H === 0) jobs.push(...dailyJobs(env, cp, scheduledTime));
  const done = await spend(env, scheduledTime, jobs);

  if (hour === BACKFILL_HOUR) {
    done.push(...(await backfill(env, parks, scheduledTime, scheduledLeft(parks, scheduledTime))));
  }
  return done;
}

/** Calls the scheduled runs still to come this UTC day will make: what a
 *  backfill must leave alone. Counts every park, open or not, so it errs high. */
export function scheduledLeft(parks: ParkConfig[], nowMs: number): number {
  const perHour = weatherParks(parks).length;
  const perDaily = 2 * calendarParks(parks).length;
  let n = 0;
  for (let h = new Date(nowMs).getUTCHours() + 1; h < 24; h++) {
    n += perHour + (h % DAILY_EVERY_H === 0 ? perDaily : 0);
  }
  return n;
}

const BACKFILL_HOUR = 3;

/** The calendar's ten days, and tomorrow's hours for its gust (the hourly
 *  timeline reaches 48 hours ahead; the daily one has no gusts). Two calls a park. */
function dailyJobs(env: Env, parks: ParkConfig[], nowMs: number): Job[] {
  return parks.flatMap((p) => {
    const tz = parkTimeZone(p);
    const yesterday = addDays(localDateOf(nowMs, tz), -1);
    const tomorrow = addDays(parkDay(nowMs, tz), 1);
    return [
      { label: `${p.key}/days`, run: () => writeDays(env, p, yesterday, nowMs) },
      { label: `${p.key}/${tomorrow}`, run: () => writeDay(env, p, tomorrow, nowMs) },
    ];
  });
}

/** The calendar's ten days for every park now, off schedule (`/weather?days=1`). */
export const runDaily = (env: Env, parks: ParkConfig[], nowMs: number): Promise<string[]> =>
  env.OPENWEATHER_KEY ? spend(env, nowMs, dailyJobs(env, calendarParks(parks), nowMs)) : Promise.resolve([]);

/**
 * Fill weather for days before the key existed, newest first:
 *  - the calendar from the park's first queue day, ten days a call;
 *  - the Queues tab for every past day that has a queue file, a call a day,
 *    taken a park at a time in turn so no park waits on another's history.
 * Bounded by the budget left after `reserve`; resumes where it stopped because
 * it only ever looks for what's missing.
 */
export async function backfill(
  env: Env,
  parks: ParkConfig[],
  nowMs: number,
  reserve: number,
  /** Most calls this pass; by hand, a few passes keep each request well inside
   *  the Worker's subrequest limit. */
  limit = Infinity,
): Promise<string[]> {
  if (!env.OPENWEATHER_KEY) return [];
  const jobs: Job[] = [];

  // From the park's first queue day: weather before that has nothing to sit
  // beside but ticket numbers.
  for (const p of calendarParks(parks)) {
    const tz = parkTimeZone(p);
    const idx = await readJson<{ minDate?: string }>(env, `queues/${p.key}/index.json`);
    if (!idx?.minDate) continue;
    const first = idx.minDate;
    const yesterday = addDays(localDateOf(nowMs, tz), -1);
    const have = new Set<string>();
    for (let m = first.slice(0, 7); m <= yesterday.slice(0, 7); m = nextMonth(m)) {
      const days = await readMonth(env.BUCKET, `calendar/${p.key}/weather/${m}.json`);
      // A gust-only entry (see setDayGust) still needs its day.
      for (const [d, w] of Object.entries(days)) if (w.min != null) have.add(d);
    }
    // Newest gap first; one call covers it and the nine days before it.
    for (let d = yesterday; d >= first; d = addDays(d, -1)) {
      if (have.has(d)) continue;
      const from = addDays(d, -9) < first ? first : addDays(d, -9);
      jobs.push({ label: `${p.key}/days@${from}`, run: () => writeDays(env, p, from, nowMs) });
      for (let k = 0; k < 10; k++) have.add(addDays(from, k));
    }
  }

  const perPark: Job[][] = [];
  for (const p of weatherParks(parks)) {
    const today = parkDay(nowMs, parkTimeZone(p));
    const queueDays = await listDates(env.BUCKET, `queues/${p.key}/`);
    const have = new Set(await listDates(env.BUCKET, `queues/${p.key}/weather/`));
    perPark.push(
      queueDays
        .filter((d) => d < today && !have.has(d))
        .sort()
        .reverse()
        .map((date) => ({ label: `${p.key}/${date}`, run: () => writeDay(env, p, date, nowMs) })),
    );
  }
  for (let i = 0; perPark.some((js) => i < js.length); i++)
    for (const js of perPark) if (i < js.length) jobs.push(js[i]);

  return spend(env, nowMs, jobs.slice(0, limit), reserve);
}

/** The `YYYY-MM-DD.json` objects directly under `prefix`, as dates. */
async function listDates(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const o of page.objects) {
      const m = /(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key);
      if (m) out.push(m[1]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as T;
  } catch {
    return null;
  }
}

const nextMonth = (m: string): string => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};
