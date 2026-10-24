import { parkDay, parkTimeZone, USER_AGENT, type OpeningHoursConfig, type ParkConfig } from "./config";
import { readDigitickets } from "./digitickets";
import { fetchDlpHours } from "./dlp";
import { fetchEftelingHours } from "./efteling";
import { fetchLisebergHours } from "./liseberg";
import { fetchPlopsaHours } from "./plopsa";
import { buildParkIcal, parkIcalKey, writeIcal, type SpecialDaysLike } from "./ical";
import { readRestrictions } from "./restrictions";
import { fetchTe2Hours } from "./te2";
import {
  logPoll,
  updateParkIndex,
  writeHoursMonths,
} from "./db";
import type { Env } from "./types";

/** One location's entry for a single day, cleaned and classified. */
export interface LocationHours {
  kind: string; // "themepark" | "waterpark" | "golf"
  name: string; // as returned by the API (e.g. "Waterpark")
  hours: string; // "10am - 6pm", "Closed", …
  /** Note shown after the hours: a genuine last-entry note, or Disneyland
   *  Paris's Extra Magic Time slot. */
  lastEntry?: string;
  event?: string; // special-event name, when the field is abused for one
}

/** One dated happening in a park's What's-On lineup (Flamingo Land). `time` is a
 *  display range ("4pm - 11pm", a single "6:15pm", or absent for all-day);
 *  `category` is the salient Tribe category, for grouping/icon in the UI. */
export interface DayEvent {
  name: string;
  time?: string;
  category?: string;
}

/** One day's opening hours across a park's locations. `event` bubbles up the
 *  themepark's special event (or, for an events-only park, the day's headline
 *  act) so the UI can badge the whole day. `events` is the full day lineup for
 *  a What's-On park (Flamingo Land) that has no per-day opening hours. */
export interface HoursDay {
  locations: LocationHours[];
  event?: string;
  events?: DayEvent[];
}

export type HoursSnapshot = Record<string, HoursDay>;

interface ApiDay {
  key?: string; // "YYYYMMDD"
  openingHours?: string;
  lastEntryTime?: string;
  message?: string;
}
interface ApiLocation {
  locationId?: number | string;
  locationName?: string;
  days?: ApiDay[];
}

const isoFromKey = (key: string): string | null =>
  key.length === 8 ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}` : null;

/**
 * The `lastEntryTime` field is overloaded. Split it into a genuine last-entry
 * note vs a special-event name:
 *  - "Special Event: X"           → event "X"
 *  - contains last/timeslot/entry/until/admission, "rides close", or looks like
 *    a clock time → lastEntry (Billund: "Rides close 1 hr before park closes")
 *  - otherwise non-empty (e.g. "Minecraft Meet the Mobs") → event
 */
export function classifyLastEntry(raw: string | undefined): {
  lastEntry?: string;
  event?: string;
} {
  const s = (raw ?? "").trim();
  if (!s) return {};

  const prefix = /^special event:\s*/i;
  if (prefix.test(s)) return { event: s.replace(prefix, "").trim() };

  const looksLikeTime = /\d\s*(am|pm|:)/i.test(s);
  const entryWords = /(last|timeslot|entry|until|admission|rides close)/i.test(s);
  if (looksLikeTime || entryWords) return { lastEntry: s };

  return { event: s };
}

export interface HoursFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: HoursSnapshot;
  datesSeen: number;
}

/** Fetch and parse one park's opening-hours calendar into a snapshot. Dispatches
 *  by source: the Merlin `getcalendar` JSON API (`accesso`), Blackpool's
 *  park-dates-times JSON API (`bpb`), Paulton's two JSON blobs (`paultons`),
 *  Flamingo Land's iCal feed (`flamingoland`), or Disneyland Paris GraphQL (`dlp`). */
export async function fetchHours(
  cfg: OpeningHoursConfig,
  bucket: R2Bucket | null = null,
): Promise<HoursFetch> {
  switch (cfg.kind) {
    case "te2":
      return fetchTe2Hours(cfg, bucket);
    case "bpb":
      return fetchBpbHours(cfg);
    case "paultons":
      return fetchPaultonsHours(cfg);
    case "flamingoland":
      return fetchFlamingolandHours(cfg);
    case "dlp":
      return fetchDlpHours(cfg);
    case "knoebels":
      return fetchKnoebelsHours(cfg);
    case "pleasurewood":
      return fetchPleasurewoodHours(cfg);
    case "crealy":
      return fetchCrealyHours(cfg);
    case "tulleys":
      return fetchTulleysHours(cfg);
    case "djurs":
      return fetchDjursHours(cfg);
    case "plopsa":
      return fetchPlopsaHours(cfg);
    case "liseberg":
      return fetchLisebergHours(cfg);
    case "efteling":
      return fetchEftelingHours(cfg);
    case "digitickets":
      return fetchDigiticketsHours(cfg);
    default:
      return fetchAccessoHours(cfg);
  }
}

/** The Merlin marketing sites' `getcalendar` JSON endpoint. */
async function fetchAccessoHours(
  cfg: Extract<OpeningHoursConfig, { kind: "accesso" }>,
): Promise<HoursFetch> {
  const kindById = new Map(cfg.locations.map((l) => [String(l.id), l.kind]));

  let resp: Response;
  try {
    resp = await fetch(cfg.calendarUrl, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  let data: { locations?: ApiLocation[] };
  try {
    data = (await resp.json()) as { locations?: ApiLocation[] };
  } catch {
    return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  }

  const snapshot: HoursSnapshot = {};
  for (const loc of data.locations ?? []) {
    const id = String(loc.locationId ?? "");
    const kind = kindById.get(id) ?? "themepark";
    const name = loc.locationName ?? "";
    for (const day of loc.days ?? []) {
      const iso = isoFromKey(String(day.key ?? ""));
      if (!iso) continue;
      const { lastEntry, event } = classifyLastEntry(day.lastEntryTime);
      const entry: LocationHours = {
        kind,
        name,
        hours: to12h(day.openingHours ?? ""),
        ...(lastEntry ? { lastEntry } : {}),
        ...(event ? { event } : {}),
      };
      const bucket = (snapshot[iso] ??= { locations: [] });
      bucket.locations.push(entry);
      // Bubble the themepark's event up to the day so the UI can badge it once.
      if (event && kind === "themepark") bucket.event = event;
    }
  }
  return { ok: true, httpStatus: resp.status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Blackpool Pleasure Beach (park-dates-times JSON API) ─────────────────────── */

/** One park-dates-times entry (only the fields we use; see docs/blackpool-api.md §6). */
interface BpbDate {
  open_date?: string; // "YYYY-MM-DD"
  time_from?: string; // "10:00am"
  time_to?: string; // "8:00pm"
  event_title?: string;
  event_link?: string;
}

/** This host is behind the same Cloudflare bot-fight as the marketing site: a
 *  thin request (UA + bare accept) 403s from the Worker, but a full modern-browser
 *  client-hint / fetch-metadata header set clears it — here tuned for a JSON XHR
 *  (`sec-fetch-dest: empty`, `mode: cors`). See docs/blackpool-api.md §6. */
const BPB_API_HEADERS: Record<string, string> = {
  "user-agent": USER_AGENT,
  accept: "application/json, text/plain, */*",
  "accept-language": "en-GB,en;q=0.9",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

/** Drop a redundant ":00" from a clock string so it reads like the Merlin hours
 *  ("10:00am" → "10am", "8:30pm" → "8:30pm"). */
const tidyTime = (s: string): string => s.trim().replace(/:00(?=\s*[ap]m)/i, "");

/**
 * Blackpool's opening calendar. A single GET on the park-dates-times JSON API
 * returns its whole forward window as an array — one object per OPEN date (the
 * same data the marketing site renders inline as `wn_dates`). We map each entry to
 * the shared HoursSnapshot as one themepark location per day. A real event
 * (`event_link` under `/events/`) is bubbled up as the day's event; the "10 hours
 * of fun" marketing tag (which links back to the opening-times page) is not.
 */
async function fetchBpbHours(
  cfg: Extract<OpeningHoursConfig, { kind: "bpb" }>,
): Promise<HoursFetch> {
  let resp: Response;
  try {
    resp = await fetch(cfg.apiUrl, { headers: BPB_API_HEADERS });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  let dates: BpbDate[];
  try {
    dates = (await resp.json()) as BpbDate[];
  } catch {
    return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  }
  if (!Array.isArray(dates)) {
    return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  }

  const snapshot: HoursSnapshot = {};
  for (const d of dates) {
    const iso = (d.open_date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const from = (d.time_from ?? "").trim();
    const to = (d.time_to ?? "").trim();
    const hours = from && to ? `${tidyTime(from)} - ${tidyTime(to)}` : "";
    // Only a genuine event (an `/events/<slug>/` link) is a real event; the
    // recurring "10 hours of fun" tag links back to the opening-times page.
    const event =
      d.event_title && /\/events\//i.test(d.event_link ?? "")
        ? d.event_title.trim()
        : undefined;
    snapshot[iso] = {
      locations: [{ kind: "themepark", name: cfg.locationName, hours }],
      ...(event ? { event } : {}),
    };
  }
  return { ok: true, httpStatus: resp.status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Pleasurewood Hills (inline arrays on one page) ──────────────────────────── */

/** "28/03/2026" → "2026-03-28". */
const ukDate = (s: string): string | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/** Every date from `from` to `to` inclusive (ISO strings). */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(isoDay(t));
  }
  return out;
}

/**
 * Pleasurewood Hills: the opening-times page builds its calendar from two
 * arrays written into the page, `openArr` and `eventArr`. Their objects are
 * plain JSON (the arrays carry a trailing comma, so each object is read on its
 * own). A blank `times` is what the page shows as "Open 10am - 5pm".
 */
async function fetchPleasurewoodHours(
  cfg: Extract<OpeningHoursConfig, { kind: "pleasurewood" }>,
): Promise<HoursFetch> {
  let resp: Response;
  try {
    resp = await fetch(cfg.pageUrl, { headers: { "user-agent": USER_AGENT } });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  const page = await resp.text();
  const array = (name: string): Record<string, string>[] => {
    const start = page.indexOf(`var ${name} = [`);
    if (start < 0) return [];
    const body = page.slice(start, page.indexOf("];", start));
    return [...body.matchAll(/\{[^{}]*\}/g)].flatMap((m) => {
      try {
        return [JSON.parse(m[0]) as Record<string, string>];
      } catch {
        return [];
      }
    });
  };
  const open = array("openArr");
  if (open.length === 0) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  const snapshot: HoursSnapshot = {};
  for (const r of open) {
    const from = ukDate(r.from ?? "");
    const to = ukDate(r.to ?? "") ?? from;
    if (!from || !to) continue;
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec((r.times ?? "").trim());
    const hours = m ? `${fmt24(m[1])} - ${fmt24(m[2])}` : "10am - 5pm";
    for (const d of datesBetween(from, to)) {
      snapshot[d] = { locations: [{ kind: "themepark", name: cfg.locationName, hours }] };
    }
  }
  // Events only label days the park is open.
  for (const e of array("eventArr")) {
    const from = ukDate(e.from ?? "");
    const to = ukDate(e.to ?? "") ?? from;
    if (!from || !to || !e.title) continue;
    for (const d of datesBetween(from, to)) if (snapshot[d]) snapshot[d].event = e.title.trim();
  }
  return { ok: true, httpStatus: resp.status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Djurs Sommerland (a data-model attribute) ───────────────────────────────── */

interface DjursEvent {
  type: number;
  start: string;
  end: string;
  days?: { ranges?: number[] };
}

/**
 * Djurs Sommerland: the page's calendar widget reads `parkEvents` from a
 * `data-model` attribute. Type 1 is the park, 2 the water park, 4 the park
 * during an event (Magisk Halloween). An entry whose start isn't a time names a
 * day (Blå Mandag) and gives the park's hours in its end ("10.00 - 20.00").
 */
async function fetchDjursHours(
  cfg: Extract<OpeningHoursConfig, { kind: "djurs" }>,
): Promise<HoursFetch> {
  let resp: Response;
  try {
    resp = await fetch(cfg.pageUrl, { headers: { "user-agent": USER_AGENT } });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  const page = await resp.text();
  const attr = /data-model="(\{&quot;parkEvents[^"]*)"/.exec(page)?.[1];
  const year = Number(/Åbningstider (\d{4})/.exec(page)?.[1] ?? new Date().getUTCFullYear());
  let events: DjursEvent[];
  try {
    events = (JSON.parse(attr!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as { parkEvents: DjursEvent[] })
      .parkEvents;
  } catch {
    return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  }
  const time = (s: string) => /^(\d{1,2})[:.](\d{2})$/.exec(s.trim());
  const hhmm = (m: RegExpExecArray) => `${m[1].padStart(2, "0")}:${m[2]}`;

  const snapshot: HoursSnapshot = {};
  // The page's calendar indexes a day as 31 * month (0-based) + date - 1.
  const day = (n: number) => {
    const month = Math.floor(n / 31);
    const date = (n % 31) + 1;
    const t = Date.UTC(year, month, date);
    return new Date(t).getUTCDate() === date ? isoDay(t) : null;
  };
  const at = (d: string) => (snapshot[d] ??= { locations: [] });
  const set = (d: string, loc: LocationHours) => {
    const ls = at(d).locations;
    const i = ls.findIndex((l) => l.kind === loc.kind);
    if (i >= 0) ls[i] = loc;
    else ls.push(loc);
  };
  // Plain days first, so a named day's hours override them.
  const named = (e: DjursEvent) => !time(e.start);
  for (const e of [...events.filter((e) => !named(e)), ...events.filter(named)]) {
    for (const n of e.days?.ranges ?? []) {
      const d = day(n);
      if (!d) continue;
      if (named(e)) {
        const m = /^(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})$/.exec(e.end.trim());
        const a = m && time(m[1]);
        const b = m && time(m[2]);
        if (a && b) set(d, { kind: "themepark", name: cfg.locationName, hours: `${fmt24(hhmm(a))} - ${fmt24(hhmm(b))}` });
        at(d).event = e.start.trim();
        continue;
      }
      const a = time(e.start);
      const b = time(e.end);
      if (!a || !b) continue;
      const hours = `${fmt24(hhmm(a))} - ${fmt24(hhmm(b))}`;
      if (e.type === 2) set(d, { kind: "waterpark", name: cfg.waterparkName, hours });
      else {
        set(d, { kind: "themepark", name: cfg.locationName, hours });
        if (e.type === 4) at(d).event = cfg.eventName;
      }
    }
  }
  // Themepark row first, as the calendar expects.
  for (const v of Object.values(snapshot)) v.locations.sort((x, y) => (x.kind === "themepark" ? -1 : y.kind === "themepark" ? 1 : 0));
  const dates = Object.keys(snapshot).length;
  return { ok: dates > 0, httpStatus: resp.status, snapshot, datesSeen: dates };
}

/* ── Pages that list dates in prose (Tulleys) ─────────────────────────────────── */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "2nd October 2026" → "2026-10-02". */
function proseDate(day: string, month: string, year: string): string | null {
  const m = MONTHS.indexOf(month.toLowerCase());
  if (m < 0) return null;
  return `${year}-${String(m + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** A page's visible text, one line per block, entities decoded. */
async function pageLines(url: string): Promise<{ status: number; lines: string[] | null }> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  } catch {
    return { status: 0, lines: null };
  }
  if (!resp.ok) return { status: resp.status, lines: null };
  const lines = (await resp.text())
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { status: resp.status, lines };
}

/**
 * Tulleys Shocktober Fest: "2nd October 2026 | Open Today: 4:30pm - 11:30pm",
 * then a note ("Park opens 4:30pm. Haunts open 5:30pm-11.30pm", sometimes with
 * more after it, such as a celebrity black-carpet night). Whatever the note adds
 * beyond the standard times sentence is the day's event.
 */
async function fetchTulleysHours(
  cfg: Extract<OpeningHoursConfig, { kind: "tulleys" }>,
): Promise<HoursFetch> {
  const { status, lines } = await pageLines(cfg.pageUrl);
  if (!lines) return { ok: false, httpStatus: status, snapshot: {}, datesSeen: 0 };
  const snapshot: HoursSnapshot = {};
  lines.forEach((line, i) => {
    const m = /^(\d{1,2})(?:st|nd|rd|th) ([A-Za-z]+) (\d{4}) \| Open Today: (.+)$/.exec(line);
    if (!m) return;
    const date = proseDate(m[1], m[2], m[3]);
    if (!date) return;
    const note = lines[i + 1] ?? "";
    const extra = note
      .replace(/^Park opens [^.]*\.\s*Haunts open [\d.:apm\s-]+/i, "")
      .replace(/\s*\([^)]*\)\s*$/, "") // "(Very Limited public tickets available)"
      .trim();
    snapshot[date] = {
      locations: [{ kind: "themepark", name: cfg.locationName, hours: m[4].trim() }],
      ...(extra && !/^Buy Tickets$/i.test(extra) ? { event: extra } : {}),
    };
  });
  if (Object.keys(snapshot).length === 0) {
    return { ok: false, httpStatus: status, snapshot: {}, datesSeen: 0 };
  }
  return { ok: true, httpStatus: status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── DigiTickets stores (the ticket shop's availability calendar) ─────────────── */

/**
 * Opening hours from a DigiTickets store: each bookable date, from its first
 * session's start to its last session's end ("6:30pm - 11pm"). A sold-out date
 * is still listed, so it still shows as open.
 */
async function fetchDigiticketsHours(
  cfg: Extract<OpeningHoursConfig, { kind: "digitickets" }>,
): Promise<HoursFetch> {
  const read = await readDigitickets(cfg);
  if (!read.ok) return { ok: false, httpStatus: read.httpStatus, snapshot: {}, datesSeen: 0 };
  const snapshot: HoursSnapshot = {};
  for (const e of read.events) {
    const times = (e.sessions ?? []).filter((s) => s.time && s.endTime);
    if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || times.length === 0) continue;
    const open = times.map((s) => s.time!).sort()[0];
    const close = times.map((s) => s.endTime!).sort().at(-1)!;
    snapshot[e.date] = {
      locations: [{ kind: "themepark", name: cfg.locationName, hours: `${fmt24(open)} - ${fmt24(close)}` }],
    };
  }
  return { ok: true, httpStatus: read.httpStatus, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Crealy (one Umbraco month fragment per request) ──────────────────────────── */

/**
 * Crealy: `RenderMonth?month=YYYY-MM-01&attractionId=&homePageId=` returns the
 * month as day buttons, each `data-date="YYYY-MM-DD"` with its hours ("10am -
 * 5pm"), an optional event banner ("Spook-Fest") and a last-entry time. A day
 * with no hours is closed and left out. Any failed month fails the poll, so a
 * partial calendar is never written.
 */
async function fetchCrealyHours(
  cfg: Extract<OpeningHoursConfig, { kind: "crealy" }>,
): Promise<HoursFetch> {
  const now = new Date();
  const snapshot: HoursSnapshot = {};
  let status = 0;
  const text = (s: string) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  for (let i = 0; i < cfg.months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const month = isoDay(d.getTime());
    const url = `${cfg.monthUrl}?month=${month}&attractionId=${cfg.attractionId}&homePageId=${cfg.homePageId}`;
    let html: string;
    try {
      const resp = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      status = resp.status;
      if (!resp.ok) return { ok: false, httpStatus: status, snapshot: {}, datesSeen: 0 };
      html = await resp.text();
    } catch {
      return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
    }
    for (const b of html.split(/<button\b/).slice(1)) {
      const date = /data-date="(\d{4}-\d{2}-\d{2})"/.exec(b)?.[1];
      if (!date || !date.startsWith(month.slice(0, 7))) continue; // other-month padding
      const times = /class="open-hours--times"[^>]*>([\s\S]*?)<\/li>/.exec(b)?.[1];
      const hours = times ? text(times).replace(/^Open:\s*/i, "") : "";
      if (!hours) continue;
      const banner = /class="open-hours--banner"[^>]*>([\s\S]*?)<\/li>/.exec(b)?.[1];
      const last = /class="last-entry--time"[^>]*>([\s\S]*?)<\/span>/.exec(b)?.[1];
      snapshot[date] = {
        locations: [
          {
            kind: "themepark",
            name: cfg.locationName,
            hours,
            ...(last ? { lastEntry: `Last entry ${text(last)}` } : {}),
          },
        ],
        ...(banner ? { event: text(banner) } : {}),
      };
    }
  }
  return { ok: true, httpStatus: status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Knoebels (one request per day) ───────────────────────────────────────────── */

/** knoebels.com robots.txt: Crawl-delay: 10. */
const KNOEBELS_DELAY_MS = 10_000;
/** The hourly hours cron's UTC hour at which Knoebels is read (06:00 Eastern
 *  in summer, before the park opens). */
export const KNOEBELS_HOUR = 10;

interface KnoebelsDay {
  date?: string;
  open?: boolean;
  ranges?: { title?: string; status?: string; opens?: string; closes?: string }[];
}

/**
 * Knoebels' hours, a day per request, one request every 10 seconds: the site's
 * robots.txt asks for a 10-second crawl delay. That makes a pass take about
 * five minutes, so it runs once a day (KNOEBELS_HOUR), not with every hourly
 * poll. A closed day is left out, as Blackpool's feed leaves it out. The range
 * title names the season or event ("Hallo-Fun"); plain "Park" is the ordinary
 * season and isn't one.
 */
async function fetchKnoebelsHours(
  cfg: Extract<OpeningHoursConfig, { kind: "knoebels" }>,
): Promise<HoursFetch> {
  const start = Date.parse(`${parkDay(Date.now(), cfg.timeZone)}T00:00:00Z`);
  const dates = Array.from({ length: cfg.windowDays }, (_, i) => isoDay(start + i * 86_400_000));
  const snapshot: HoursSnapshot = {};
  let status = 0;
  let failed = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, KNOEBELS_DELAY_MS));
    const date = dates[i];
    let day: KnoebelsDay;
    try {
      const resp = await fetch(`${cfg.hoursUrl}?day=${date}`, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      status = resp.status;
      if (!resp.ok) throw new Error(String(resp.status));
      day = (await resp.json()) as KnoebelsDay;
    } catch {
      failed++;
      continue;
    }
    const open = (day.ranges ?? []).filter((r) => r.status === "open" && r.opens && r.closes);
    if (!day.open || open.length === 0) continue;
    const hours = open.map((r) => `${fmt24(r.opens!)} - ${fmt24(r.closes!)}`).join(", ");
    const event = open.map((r) => r.title?.trim()).find((t) => t && t.toLowerCase() !== "park");
    snapshot[date] = {
      locations: [{ kind: "themepark", name: cfg.locationName, hours }],
      ...(event ? { event } : {}),
    };
  }
  // A partial window would write a partial iCal feed; treat it as a failed poll
  // and keep what's on file.
  if (failed > 0) return { ok: false, httpStatus: status, snapshot: {}, datesSeen: 0 };
  return { ok: true, httpStatus: status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Paulton's Park (two JSON blobs) ──────────────────────────────────────────── */

interface PaultonsTimes {
  open?: string; // "10:00" (24h local)
  closed?: string; // "17:30"
  dates?: string[]; // ["2026-07-22", …]
}
interface PaultonsEvent {
  start?: string; // unix seconds (string)
  end?: string;
  name?: string;
}

/** "10:00 - 17:00" → "10am - 5pm". Most Merlin sites already write 12-hour
 *  times; Heide Park's writes 24-hour ones. Anything else passes through. */
function to12h(hours: string): string {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(hours.trim());
  return m ? `${fmt24(m[1])} - ${fmt24(m[2])}` : hours.trim();
}

/** "10:00" → "10am", "17:30" → "5:30pm", "10:30" → "10:30am" — matching the
 *  Merlin/BPB hours style (":00" dropped, 12-hour with am/pm). */
export function fmt24(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm.trim();
  const h = Number(m[1]);
  const min = m[2];
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === "00" ? `${h12}${ampm}` : `${h12}:${min}${ampm}`;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Paulton's opening calendar, assembled from two plain JSON blobs:
 *   - `times`: `[{open,closed,dates[]}]` — each entry is one set of hours shared
 *     by a list of dates. We expand it to one themepark location row per date.
 *   - `special-events`: `[{start,end,name}]` — unix-second date RANGES. We badge
 *     every open day inside a range with the event name (matching how the Merlin
 *     `event` bubbles up per day). A range-only day with no `times` entry gets no
 *     row (nothing to open), so events only ever decorate real operating days.
 */
async function fetchPaultonsHours(
  cfg: Extract<OpeningHoursConfig, { kind: "paultons" }>,
): Promise<HoursFetch> {
  let timesResp: Response;
  let eventsResp: Response;
  try {
    [timesResp, eventsResp] = await Promise.all([
      fetch(cfg.timesUrl, { headers: { accept: "application/json", "user-agent": USER_AGENT } }),
      fetch(cfg.eventsUrl, { headers: { accept: "application/json", "user-agent": USER_AGENT } }),
    ]);
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  // Times is the source of truth for which days exist; events are decoration, so
  // a failed events fetch just means no badges (don't fail the whole poll).
  if (!timesResp.ok) return { ok: false, httpStatus: timesResp.status, snapshot: {}, datesSeen: 0 };

  let times: PaultonsTimes[];
  try {
    times = (await timesResp.json()) as PaultonsTimes[];
  } catch {
    return { ok: false, httpStatus: timesResp.status, snapshot: {}, datesSeen: 0 };
  }
  if (!Array.isArray(times)) {
    return { ok: false, httpStatus: timesResp.status, snapshot: {}, datesSeen: 0 };
  }

  const snapshot: HoursSnapshot = {};
  for (const t of times) {
    const open = (t.open ?? "").trim();
    const closed = (t.closed ?? "").trim();
    const hours = open && closed ? `${fmt24(open)} - ${fmt24(closed)}` : "";
    for (const iso of t.dates ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
      snapshot[iso] = {
        locations: [{ kind: "themepark", name: cfg.locationName, hours }],
      };
    }
  }

  // Badge each open day that falls inside a special-event's date range.
  let events: PaultonsEvent[] = [];
  if (eventsResp.ok) {
    try {
      const parsed = (await eventsResp.json()) as PaultonsEvent[];
      if (Array.isArray(parsed)) events = parsed;
    } catch {
      /* ignore — events are optional decoration */
    }
  }
  for (const e of events) {
    const start = Number(e.start);
    const end = Number(e.end);
    const name = (e.name ?? "").trim();
    if (!name || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    // Walk day by day across the (inclusive) range; only tag days we actually open.
    for (let ms = start * 1000; ms <= end * 1000; ms += 86_400_000) {
      const day = snapshot[isoDay(ms)];
      if (day) day.event = name;
    }
  }

  return { ok: true, httpStatus: timesResp.status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Flamingo Land (The Events Calendar iCal feed) ────────────────────────────── */

/** One parsed VEVENT (only the fields we use; see docs/flamingoland-calendar.md). */
interface IcalEvent {
  uid: string;
  iso: string; // "YYYY-MM-DD" (from DTSTART)
  start: string; // raw DTSTART value, for chronological sort
  time?: string; // display range, e.g. "4pm - 11pm" or "6:15pm"
  name: string;
  cats: string[];
}

/** Unescape an iCal TEXT value (RFC 5545 §3.3.11): `\, \; \\ \n`. */
const icalUnescape = (s: string): string =>
  s
    .replace(/\\[nN]/g, " ")
    .replace(/\\([,;\\])/g, "$1")
    .trim();

/** A `DTSTART`/`DTEND` value → the "HH:MM" 24h clock, or "" for an all-day
 *  (date-only) value. `20260725T160000` → "16:00". */
const icalClock = (value: string): string => {
  const m = /^\d{8}T(\d{2})(\d{2})/.exec(value);
  return m ? `${m[1]}:${m[2]}` : "";
};

/** Parse an iCal document into events. Handles RFC 5545 line folding and picks
 *  DTSTART/DTEND/UID/SUMMARY/CATEGORIES; times are Europe/London wall-clock, used
 *  verbatim (no timezone conversion). */
function parseIcal(text: string): IcalEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const out: IcalEvent[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const field = (name: string): string => {
      // Property name, optional `;params`, then `:value` up to end of line.
      const m = new RegExp(`^${name}[^:\\r\\n]*:(.*)$`, "m").exec(body);
      return m ? m[1].trim() : "";
    };
    const dtstart = field("DTSTART");
    const iso =
      dtstart.length >= 8
        ? `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`
        : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const name = icalUnescape(field("SUMMARY"));
    if (!name) continue;
    const uid = field("UID") || `${iso}~${name}`;
    const s = icalClock(dtstart);
    const e = icalClock(field("DTEND"));
    const time = !s ? undefined : e && e !== s ? `${fmt24(s)} - ${fmt24(e)}` : fmt24(s);
    const cats = field("CATEGORIES")
      .split(",")
      .map((c) => icalUnescape(c))
      .filter(Boolean);
    out.push({ uid, iso, start: dtstart, time, name, cats });
  }
  return out;
}

/** Shift an ISO date by whole days (UTC arithmetic — dates are calendar days). */
const isoAddDays = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** The salient category for grouping/display, most-specific first. */
const CATEGORY_PRIORITY = [
  "Main Act",
  "Special Events",
  "Things To Do",
  "Daytime Shows",
  "Kids Entertainment",
  "Evening Entertainment",
];
const categoryLabel = (cats: string[]): string | undefined => {
  for (const p of CATEGORY_PRIORITY) if (cats.includes(p)) return p;
  return cats[0];
};

/** The categories (in priority order) whose events are worth badging on a day. */
const HEADLINE_PRIORITY = ["Main Act", "Special Events", "Things To Do"];

/** Pick a day's headline badge: the best-priority category present, its event
 *  name(s) joined ("Lilly Street · RE TAKE THAT"). Undefined for a plain
 *  daily-shows day. */
function pickHeadline(events: DayEvent[]): string | undefined {
  for (const p of HEADLINE_PRIORITY) {
    const names = [...new Set(events.filter((e) => e.category === p).map((e) => e.name))];
    if (names.length) return names.join(" · ");
  }
  return undefined;
}

/**
 * Flamingo Land's What's-On calendar, built from The Events Calendar iCal feed.
 * The feed caps each response at 30 VEVENTs and the daily lineup is dense
 * (~9–13/day), so we WALK forward: fetch from today, re-request starting at the
 * furthest date returned, dedupe by UID, and stop once we've covered
 * `windowDays` ahead, the walk stops advancing, or `maxPages` (subrequest
 * backstop) is hit. Each day maps to a HoursSnapshot entry with no opening-hours
 * rows — just the day's `events` lineup and a headline `event` badge.
 * See docs/flamingoland-calendar.md.
 */
async function fetchFlamingolandHours(
  cfg: Extract<OpeningHoursConfig, { kind: "flamingoland" }>,
): Promise<HoursFetch> {
  const today = new Date().toISOString().slice(0, 10);
  const windowDays = cfg.windowDays ?? 15;
  const maxPages = cfg.maxPages ?? 14;
  const horizon = isoAddDays(today, windowDays);

  const byUid = new Map<string, IcalEvent>();
  let cursor = today;
  let lastStatus = 0;
  let anyOk = false;

  for (let page = 0; page < maxPages; page++) {
    const url = `${cfg.icalUrl}?tribe-bar-date=${cursor}&ical=1`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/calendar, text/plain, */*",
          "accept-language": "en-GB,en;q=0.9",
        },
      });
    } catch {
      break;
    }
    lastStatus = resp.status;
    if (!resp.ok) break;
    const events = parseIcal(await resp.text());
    if (events.length === 0) break;
    anyOk = true;

    let maxIso = cursor;
    for (const ev of events) {
      byUid.set(ev.uid, ev);
      if (ev.iso > maxIso) maxIso = ev.iso;
    }
    if (maxIso >= horizon || maxIso <= cursor) break; // window covered, or no progress
    cursor = maxIso; // re-request from the furthest day (overlap is deduped)
  }

  if (!anyOk) return { ok: false, httpStatus: lastStatus, snapshot: {}, datesSeen: 0 };

  // Group the (future) events by day, chronologically within each day.
  const perDay = new Map<string, IcalEvent[]>();
  for (const ev of byUid.values()) {
    if (ev.iso < today) continue; // drop stray past/recurring-master entries
    const bucket = perDay.get(ev.iso) ?? [];
    if (bucket.length === 0) perDay.set(ev.iso, bucket);
    bucket.push(ev);
  }

  const snapshot: HoursSnapshot = {};
  for (const [iso, evs] of perDay) {
    evs.sort((a, b) => a.start.localeCompare(b.start));
    const events: DayEvent[] = evs.map((e) => ({
      name: e.name,
      ...(e.time ? { time: e.time } : {}),
      ...(categoryLabel(e.cats) ? { category: categoryLabel(e.cats) } : {}),
    }));
    const headline = pickHeadline(events);
    snapshot[iso] = { locations: [], events, ...(headline ? { event: headline } : {}) };
  }
  return {
    ok: true,
    httpStatus: lastStatus,
    snapshot,
    datesSeen: Object.keys(snapshot).length,
  };
}


/**
 * Regenerate the park's subscribable calendar from the snapshot this poll just
 * produced. The hours are already in memory, so this costs two small R2 reads
 * (the buyout days and, for a Merlin park, the pass restrictions) and a write
 * only when the feed's substance actually changed. Never throws: a feed is a
 * convenience, and failing one must not fail the hours poll behind it.
 */
async function refreshParkIcal(
  env: Env,
  park: ParkConfig,
  snapshot: HoursSnapshot,
  observedAt: string,
): Promise<void> {
  try {
    const [specialObj, restrictions] = await Promise.all([
      env.BUCKET.get(`calendar/${park.key}/special.json`),
      park.merlinPass ? readRestrictions(env.BUCKET) : Promise.resolve(null),
    ]);
    let special: SpecialDaysLike | null = null;
    if (specialObj) {
      try {
        special = (await specialObj.json()) as SpecialDaysLike;
      } catch {
        /* a malformed file just means no buyout labels */
      }
    }
    const body = buildParkIcal({
      parkKey: park.key,
      parkLabel: park.label,
      timeZone: parkTimeZone(park),
      snapshot,
      special,
      restrictions,
      // From the start of the current month: settled history belongs in the
      // site's calendar, not in a subscriber's.
      from: `${observedAt.slice(0, 7)}-01`,
      generatedAt: observedAt,
    });
    await writeIcal(env.BUCKET, parkIcalKey(park.key), body);
  } catch {
    /* keep the last good feed */
  }
}

/**
 * One opening-hours poll for one park: fetch the marketing-site calendar and
 * overwrite the served R2 file. Unlike availability there's no delta log —
 * hours change rarely and the file is small, so we just rewrite it wholesale.
 */
export async function runHoursPoll(env: Env, park: ParkConfig): Promise<number> {
  // A queue-only park (Paulton's) has no marketing-site calendar to poll.
  const cfg = park.openingHours;
  if (!cfg) return 0;
  // Once a day: a full pass at Knoebels' crawl delay takes about five minutes.
  if (cfg.kind === "knoebels" && new Date().getUTCHours() !== KNOEBELS_HOUR) return 0;
  const observedAt = new Date().toISOString();
  const res = await fetchHours(cfg, env.BUCKET);
  if (res.ok) {
    await writeHoursMonths(env.BUCKET, park.key, res.snapshot, observedAt);
    // Keep the calendar's month-nav bounds current. Availability products drive
    // this for the Merlin parks; a hours-only park (Blackpool) has none, so the
    // hours poll must extend the index itself. Monotonic, so this is harmless
    // where availability already covers a wider range.
    const months = [...new Set(Object.keys(res.snapshot).map((iso) => iso.slice(0, 7)))];
    await updateParkIndex(env.BUCKET, park.key, months, observedAt);
    await refreshParkIcal(env, park, res.snapshot, observedAt);
  }
  await logPoll(
    env.DB,
    park.key,
    "hours",
    res.httpStatus,
    res.ok ? "OK" : "FAILED",
    res.datesSeen,
    res.datesSeen,
    observedAt,
  );
  return res.datesSeen;
}
