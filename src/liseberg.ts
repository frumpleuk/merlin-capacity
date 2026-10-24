import { parkDay, tzOffsetMin, USER_AGENT, type LisebergConfig, type OpeningHoursConfig } from "./config";
import { fmt24, type HoursFetch, type HoursSnapshot } from "./hours";
import type { ResortWindow } from "./queues";
import type { RideCatalog, RideMeta } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Liseberg, from the API behind its app (`www.liseberg.se/en/api/app/`).
 * Public: no key. See docs/liseberg-api.md.
 *
 *   - `attractions/`: every ride with its name, coordinates, height text and
 *     live `state` ({isOpen, maxWaitTime in minutes or -1, status}). `status`
 *     reads "Today: 11:00 - 20:00" while the ride has hours today, which gives
 *     each ride its own window: shut outside it, down inside it.
 *   - `calendar/<date>/<days>`: one entry a day, `closed` or whole-hour
 *     `openingHoursDetailed.from`/`to`.
 */

interface Attraction {
  id?: number;
  title?: string;
  type?: string;
  heightLimitation?: string | null;
  state?: { isOpen?: boolean; maxWaitTime?: number | null; status?: string | null };
}

/** "At least 130 cm or 120 cm if accompanied by adult" → 1.2 with an adult,
 *  1.3 alone; "At least 100 cm" → 1.0. */
export function parseLisebergHeight(text: string | null | undefined): Pick<RideMeta, "minHeight" | "minHeightUnaccompanied"> {
  const m = /at least (\d+)\s*cm(?:\s*or\s*(\d+)\s*cm if accompanied)?/i.exec(text ?? "");
  if (!m) return {};
  const alone = Number(m[1]) / 100;
  return m[2] ? { minHeight: Number(m[2]) / 100, minHeightUnaccompanied: alone } : { minHeight: alone };
}

/** "Today: 11:00 - 20:00" → that window, minutes since `${today}T00:00:00Z`. */
function rideWindow(status: string | null | undefined, today: string, timeZone: string): ResortWindow | undefined {
  const m = /^Today:\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/i.exec(status?.trim() ?? "");
  if (!m) return undefined;
  const off = tzOffsetMin(today, timeZone);
  const open = Number(m[1]) * 60 + Number(m[2]) - off;
  let close = Number(m[3]) * 60 + Number(m[4]) - off;
  if (close <= open) close += 24 * 60; // past midnight
  return { open, close };
}

export interface LisebergFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  catalog: RideCatalog;
  rideWindows: Record<number, ResortWindow>;
  linesSeen: number;
}

export async function fetchLisebergQueues(cfg: LisebergConfig, timeZone: string, now: number): Promise<LisebergFetch> {
  const catalog: RideCatalog = {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "thrill",
    items: {},
    queueLines: {},
  };
  const fail = (httpStatus: number): LisebergFetch => ({
    ok: false,
    httpStatus,
    snapshot: {},
    catalog,
    rideWindows: {},
    linesSeen: 0,
  });
  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}attractions/`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch {
    return fail(0);
  }
  if (!resp.ok) return fail(resp.status);
  const rows = (await resp.json().catch(() => null)) as Attraction[] | null;
  if (!Array.isArray(rows)) return fail(resp.status);

  const today = parkDay(now, timeZone);
  const nowMin = (now - Date.parse(`${today}T00:00:00Z`)) / 60_000;
  const snapshot: QueueSnapshot = {};
  const rideWindows: Record<number, ResortWindow> = {};
  for (const r of rows) {
    const name = r.title?.trim();
    if (r.type !== "attraction" || typeof r.id !== "number" || !name) continue;
    const rideId = r.id;
    catalog.items[String(rideId)] = { name, ...parseLisebergHeight(r.heightLimitation) };
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };

    const w = rideWindow(r.state?.status, today, timeZone);
    if (w) rideWindows[rideId] = w;
    const running = r.state?.isOpen === true;
    const scheduled = !!w && nowMin >= w.open && nowMin < w.close;
    const wait = r.state?.maxWaitTime;
    snapshot[`${rideId}:${rideId}`] = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running && typeof wait === "number" && wait >= 0 ? Math.round(wait) : null,
      status: null,
      isOpen: running || scheduled,
      isOperational: running,
    } satisfies QueueObs;
  }
  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    catalog,
    rideWindows,
    linesSeen: Object.keys(snapshot).length,
  };
}

/* ── Opening hours ───────────────────────────────────────────────────────────── */

interface CalendarDay {
  dateRaw?: string;
  closed?: boolean;
  openingHoursDetailed?: { from?: string; to?: string } | null;
}

/** "11" or "11:30" → "11:00" / "11:30". */
const clock = (s: string | undefined) => {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec((s ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2] ?? "00"}` : null;
};

export async function fetchLisebergHours(
  cfg: Extract<OpeningHoursConfig, { kind: "liseberg" }>,
): Promise<HoursFetch> {
  const today = new Date().toISOString().slice(0, 10);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}calendar/${today}/${cfg.windowDays}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  const days = (await resp.json().catch(() => null)) as CalendarDay[] | null;
  if (!Array.isArray(days)) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  const snapshot: HoursSnapshot = {};
  for (const d of days) {
    const date = d.dateRaw?.slice(0, 10);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const from = clock(d.openingHoursDetailed?.from);
    const to = clock(d.openingHoursDetailed?.to);
    const hours = !d.closed && from && to ? `${fmt24(from)} - ${fmt24(to)}` : "Closed";
    snapshot[date] = { locations: [{ kind: "themepark", name: cfg.locationName, hours }] };
  }
  const n = Object.keys(snapshot).length;
  return { ok: n > 0, httpStatus: resp.status, snapshot, datesSeen: n };
}
