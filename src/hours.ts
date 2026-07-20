import { USER_AGENT, type OpeningHoursConfig, type ParkConfig } from "./config";
import { logPoll, updatePollStatusHashed, writeHoursMonths } from "./db";
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

/** Fetch and parse one park's opening-hours calendar into a snapshot. */
export async function fetchHours(
  cfg: OpeningHoursConfig,
): Promise<{ ok: boolean; httpStatus: number; snapshot: HoursSnapshot; datesSeen: number }> {
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
  const observedAt = new Date().toISOString();
  const res = await fetchHours(park.openingHours);
  if (res.ok) {
    await writeHoursMonths(env.BUCKET, park.key, res.snapshot, observedAt);
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
