import { USER_AGENT, type OpeningHoursConfig, type ParkConfig } from "./config";
import {
  logPoll,
  updateParkIndex,
  updatePollStatusHashed,
  writeHoursMonths,
} from "./db";
import type { Env } from "./types";

/** One location's entry for a single day, cleaned and classified. */
export interface LocationHours {
  kind: string; // "themepark" | "waterpark" | "golf"
  name: string; // as returned by the API (e.g. "Waterpark")
  hours: string; // "10am - 6pm", "Closed", …
  lastEntry?: string; // genuine last-entry note, when present
  event?: string; // special-event name, when the field is abused for one
}

/** One day's opening hours across a park's locations. `event` bubbles up the
 *  themepark's special event so the UI can badge the whole day. */
export interface HoursDay {
  locations: LocationHours[];
  event?: string;
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
 *  - contains last/timeslot/entry/until, or looks like a clock time → lastEntry
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
  const entryWords = /(last|timeslot|entry|until|admission)/i.test(s);
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
 *  by source: the Merlin `getcalendar` JSON API (`accesso`) or Blackpool's
 *  inline-`wn_dates` marketing-site scrape (`bpb`). */
export async function fetchHours(cfg: OpeningHoursConfig): Promise<HoursFetch> {
  return cfg.kind === "bpb" ? fetchBpbHours(cfg) : fetchAccessoHours(cfg);
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
        hours: (day.openingHours ?? "").trim(),
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

/* ── Blackpool Pleasure Beach (marketing-site scrape) ─────────────────────────── */

/** One `wn_dates` entry (only the fields we use; see docs/blackpool-api.md §6). */
interface WnDate {
  open_date?: string; // "YYYY-MM-DD"
  time_from?: string; // "10:00am"
  time_to?: string; // "8:00pm"
  event_title?: string;
  event_link?: string;
}

/** The site is behind Cloudflare bot-fight: a bare UA gets a 403, but a full
 *  modern-browser header set clears it (a Worker `fetch` sending these passes
 *  too — see docs/blackpool-api.md §6). */
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

/** Drop a redundant ":00" from a clock string so it reads like the Merlin hours
 *  ("10:00am" → "10am", "8:30pm" → "8:30pm"). */
const tidyTime = (s: string): string => s.trim().replace(/:00(?=\s*[ap]m)/i, "");

/**
 * Blackpool's opening calendar. The page server-renders its whole forward window
 * inline as `var wn_dates = [ … ]` (one object per OPEN date) — no AJAX — so a
 * single GET yields everything. We map each entry to the shared HoursSnapshot as
 * one themepark location per day. A real event (`event_link` under `/events/`) is
 * bubbled up as the day's event; the "10 hours of fun" marketing tag (which links
 * back to the opening-times page) is not.
 */
async function fetchBpbHours(
  cfg: Extract<OpeningHoursConfig, { kind: "bpb" }>,
): Promise<HoursFetch> {
  let resp: Response;
  try {
    resp = await fetch(cfg.pageUrl, { headers: BROWSER_HEADERS });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  const html = await resp.text();
  const m = html.match(/var\s+wn_dates\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  let dates: WnDate[];
  try {
    dates = JSON.parse(m[1]) as WnDate[];
  } catch {
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

/** A stable content hash of the forward (today onward) hours + events, so the
 *  status's `last_changed` advances only on a real change (a new event, changed
 *  times), not when a past day simply drops out of the fetched window. */
function hashHours(snapshot: HoursSnapshot, fromDate: string): string {
  const parts: string[] = [];
  for (const iso of Object.keys(snapshot).sort()) {
    if (iso < fromDate) continue;
    const day = snapshot[iso];
    const locs = day.locations
      .map((l) => `${l.kind}~${l.hours}~${l.lastEntry ?? ""}~${l.event ?? ""}`)
      .sort()
      .join("|");
    parts.push(`${iso}#${day.event ?? ""}#${locs}`);
  }
  const str = parts.join("\n");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
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
  const observedAt = new Date().toISOString();
  const res = await fetchHours(cfg);
  if (res.ok) {
    await writeHoursMonths(env.BUCKET, park.key, res.snapshot, observedAt);
    // Keep the calendar's month-nav bounds current. Availability products drive
    // this for the Merlin parks; a hours-only park (Blackpool) has none, so the
    // hours poll must extend the index itself. Monotonic, so this is harmless
    // where availability already covers a wider range.
    const months = [...new Set(Object.keys(res.snapshot).map((iso) => iso.slice(0, 7)))];
    await updateParkIndex(env.BUCKET, park.key, months, observedAt);
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
  const hash = res.ok ? hashHours(res.snapshot, observedAt.slice(0, 10)) : null;
  await updatePollStatusHashed(env.BUCKET, park.key, "hours", observedAt, hash);
  return res.datesSeen;
}
