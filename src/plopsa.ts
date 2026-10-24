import { parkDay, tzOffsetMin, USER_AGENT, type OpeningHoursConfig, type PlopsaConfig } from "./config";
import { fmt24, type HoursFetch, type HoursSnapshot, type LocationHours } from "./hours";
import type { RideCatalog, RideMeta } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Plopsaland De Panne, from the Azure API middleware behind the Plopsa app
 * (React Native, 2025). Public: no key, no token. See docs/plopsa-api.md.
 *
 *   - `api/attractions/waiting-times` is a flat `{rideId: minutes}`. 0 is the
 *     feed's default, sent for every ride overnight and for closed ones, so
 *     only a positive number says a ride is running.
 *   - `api/points-of-interest` names the rides (`plopsa_id` is the feed's id)
 *     and carries `schedule_info.temporarily_closed`, the only sign a ride is
 *     down. It changes through the day, so it's re-read every few minutes.
 *   - `api/park-opening-hours?openOn=` gives today's window; read once per park
 *     day.
 */

/** How long the POI read (names and the temporarily-closed flags) stands. */
const POI_TTL_MS = 5 * 60_000;

const metaKey = (park: string) => `queues/${park}/plopsa-meta.json`;

interface PoiItem {
  id?: string;
  plopsa_id?: string;
  title?: string;
  type?: string;
  experience?: { label?: string }[];
  height_specs?: { max_height?: number; min_height?: number; min_height_supervised?: number };
  schedule_info?: { temporarily_closed?: boolean };
}

interface PlopsaMeta {
  /** Park day the window belongs to. */
  date: string;
  /** When the POIs were read (ms). */
  poisAt: number;
  rides: Record<string, RideMeta>;
  /** Ride id → temporarily closed. */
  closed: Record<string, boolean>;
  /** Today's window, minutes since `${date}T00:00:00Z`; absent on a closed day
   *  or before the hours read has worked. */
  window?: { open: number; close: number };
  /** Whether today's hours read has answered (a closed day included). */
  windowRead?: boolean;
  /** Rides already flagged at the first POI read inside today's window: shut
   *  for the day (a water ride out of season), not down. */
  closedAtOpen?: string[];
}

async function plopsaGet(cfg: PlopsaConfig, path: string): Promise<Response | null> {
  try {
    return await fetch(`${cfg.apiUrl}/api/${path}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch {
    return null;
  }
}

/** One group per ride from the park's experience tags, most thrilling first. */
const GROUP_ORDER = ["Thrills", "Family", "Children"];

function rideMeta(p: PoiItem): RideMeta | null {
  const name = (p.title ?? "").trim();
  if (!name) return null;
  const tags = new Set((p.experience ?? []).map((e) => e.label));
  const group = GROUP_ORDER.find((g) => tags.has(g));
  const h = p.height_specs ?? {};
  const m = (cm: number | undefined) => (cm && cm > 0 ? cm / 100 : undefined);
  // `min_height_supervised` is the floor with an adult; `min_height` the height
  // to ride alone. Without a supervised figure, `min_height` is the floor.
  const supervised = m(h.min_height_supervised);
  const alone = m(h.min_height);
  return {
    name,
    ...(group ? { group } : {}),
    ...(supervised ? { minHeight: supervised, ...(alone ? { minHeightUnaccompanied: alone } : {}) } : alone ? { minHeight: alone } : {}),
    ...(m(h.max_height) ? { maxHeight: m(h.max_height) } : {}),
  };
}

/** Rides and their closed flags, English names first and Dutch for any ride the
 *  English feed doesn't carry yet (new rides land in Dutch first). */
async function readPois(cfg: PlopsaConfig): Promise<Pick<PlopsaMeta, "rides" | "closed"> | null> {
  const lists = await Promise.all(
    ["en", "nl"].map(async (lang) => {
      const r = await plopsaGet(cfg, `points-of-interest?language=${lang}&park=${cfg.park}`);
      const body = r?.ok ? ((await r.json().catch(() => null)) as { items?: { contains?: PoiItem[] }[] } | null) : null;
      return body?.items ? body.items.flatMap((i) => i.contains ?? []) : null;
    }),
  );
  if (!lists[0]) return null;
  const rides: PlopsaMeta["rides"] = {};
  const closed: PlopsaMeta["closed"] = {};
  for (const p of [...lists[0], ...(lists[1] ?? [])]) {
    if (p.type !== "attraction" || !p.plopsa_id || rides[p.plopsa_id]) continue;
    const meta = rideMeta(p);
    if (!meta) continue;
    rides[p.plopsa_id] = meta;
    closed[p.plopsa_id] = p.schedule_info?.temporarily_closed === true;
  }
  return Object.keys(rides).length ? { rides, closed } : null;
}

/** Today's opening window, or null when the read failed. A closed day comes
 *  back as an answer with no window. */
async function readWindow(
  cfg: PlopsaConfig,
  today: string,
  timeZone: string,
): Promise<{ window?: PlopsaMeta["window"] } | null> {
  const r = await plopsaGet(cfg, `park-opening-hours?language=en&park=${cfg.park}&openOn=${today}`);
  if (!r?.ok) return null;
  const body = (await r.json().catch(() => null)) as {
    timeslots?: { type?: string; start_time?: string; end_time?: string }[];
  } | null;
  if (!body || !Array.isArray(body.timeslots)) return null;
  const open = body.timeslots.filter((s) => s.type === "open" && s.start_time && s.end_time);
  if (!open.length) return {};
  const off = tzOffsetMin(today, timeZone);
  const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) - off;
  return {
    window: {
      open: Math.min(...open.map((s) => min(s.start_time!))),
      close: Math.max(...open.map((s) => min(s.end_time!))),
    },
  };
}

/** Today's meta: POIs re-read once stale, the window once per park day. A
 *  failed read keeps the cached copy, so one bad answer never shuts the park. */
async function loadMeta(
  cfg: PlopsaConfig,
  bucket: R2Bucket | null,
  park: string,
  today: string,
  timeZone: string,
  now: number,
): Promise<PlopsaMeta | null> {
  const obj = await bucket?.get(metaKey(park));
  const cached = obj ? ((await obj.json().catch(() => null)) as PlopsaMeta | null) : null;
  const sameDay = cached?.date === today;
  const nowMin = (now - Date.parse(`${today}T00:00:00Z`)) / 60_000;
  const window = sameDay ? cached?.window : undefined;
  const inWindow = !!window && nowMin >= window.open && nowMin < window.close;
  const needPois = !cached || now - cached.poisAt >= POI_TTL_MS || (inWindow && !cached.closedAtOpen);
  const needWindow = !sameDay || !cached?.windowRead;
  if (!needPois && !needWindow) return cached;

  const [pois, win] = await Promise.all([
    needPois ? readPois(cfg) : Promise.resolve(null),
    needWindow ? readWindow(cfg, today, timeZone) : Promise.resolve(null),
  ]);
  const base = cached ?? (pois ? { date: today, poisAt: now, ...pois } : null);
  if (!base) return null;
  const w = win ? win.window : window;
  const openNow = !!w && nowMin >= w.open && nowMin < w.close;
  const closedAtOpen =
    sameDay && cached?.closedAtOpen
      ? cached.closedAtOpen
      : openNow && pois
        ? Object.keys(pois.closed).filter((id) => pois.closed[id])
        : undefined;
  const next: PlopsaMeta = {
    ...(closedAtOpen ? { closedAtOpen } : {}),
    date: today,
    poisAt: pois ? now : base.poisAt,
    rides: pois?.rides ?? base.rides,
    closed: pois?.closed ?? base.closed,
    ...(win
      ? { ...(win.window ? { window: win.window } : {}), windowRead: true }
      : sameDay && cached?.window
        ? { window: cached.window }
        : {}),
  };
  await bucket?.put(metaKey(park), JSON.stringify(next), {
    httpMetadata: { contentType: "application/json" },
  });
  return next;
}

export interface PlopsaFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  catalog: RideCatalog;
  resort?: { open: number; close: number };
  linesSeen: number;
}

export async function fetchPlopsaQueues(
  cfg: PlopsaConfig,
  bucket: R2Bucket | null,
  park: string,
  timeZone: string,
  now: number,
): Promise<PlopsaFetch> {
  const catalog: RideCatalog = {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "thrill",
    items: {},
    queueLines: {},
  };
  const fail = (httpStatus: number): PlopsaFetch => ({ ok: false, httpStatus, snapshot: {}, catalog, linesSeen: 0 });

  const today = parkDay(now, timeZone);
  const [meta, resp] = await Promise.all([
    loadMeta(cfg, bucket, park, today, timeZone, now),
    plopsaGet(cfg, `attractions/waiting-times?language=en&park=${cfg.park}`),
  ]);
  if (!resp) return fail(0);
  if (!resp.ok) return fail(resp.status);
  if (!meta) return fail(resp.status);
  const waits = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!waits || typeof waits !== "object" || Array.isArray(waits)) return fail(resp.status);

  const nowMin = (now - Date.parse(`${today}T00:00:00Z`)) / 60_000;
  const inWindow = !!meta.window && nowMin >= meta.window.open && nowMin < meta.window.close;

  const shut = new Set(meta.closedAtOpen ?? []);
  const snapshot: QueueSnapshot = {};
  for (const [id, raw] of Object.entries(waits)) {
    const ride = meta.rides[id];
    const rideId = Number(id);
    if (!ride || !Number.isInteger(rideId)) continue;
    const wait = typeof raw === "number" && raw > 0 ? Math.round(raw) : null;
    // A posted wait wins over a stale closed flag; otherwise the flag decides.
    // Flagged since opening is shut for the day; flagged later is down.
    const running = inWindow && (wait != null || !meta.closed[id]);
    const down = inWindow && !running && !shut.has(id);
    snapshot[`${rideId}:${rideId}`] = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running ? wait : null,
      status: null,
      isOpen: running || down,
      isOperational: running,
    } satisfies QueueObs;
    catalog.items[String(rideId)] = ride;
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };
  }

  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    catalog,
    ...(meta.window ? { resort: meta.window } : {}),
    linesSeen: Object.keys(snapshot).length,
  };
}

/* ── Opening hours ───────────────────────────────────────────────────────────── */

interface CalendarDay {
  closed?: boolean;
  sold_out?: boolean;
  labels?: { title?: string }[];
  slots?: { type?: string; start_time?: string; end_time?: string }[];
}

/** Labels longer than this are notes about the day, not event names. */
const NOTE_LENGTH = 60;

/**
 * The plopsa.com calendar (`opening-hours-calendar?start=&end=`): every date in
 * the range, closed or open with its slots (ISO times with offsets) and labels
 * (the day's events, and the odd note such as "adjusted opening hours apply").
 * A sold-out day lists no slots.
 */
export async function fetchPlopsaHours(
  cfg: Extract<OpeningHoursConfig, { kind: "plopsa" }>,
): Promise<HoursFetch> {
  const start = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const url = `${cfg.calendarUrl}?start=${iso(start)}&end=${iso(start + cfg.windowDays * 86_400_000)}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };
  const body = (await resp.json().catch(() => null)) as { schedule?: Record<string, Record<string, CalendarDay>> } | null;
  if (!body?.schedule) return { ok: false, httpStatus: resp.status, snapshot: {}, datesSeen: 0 };

  const snapshot: HoursSnapshot = {};
  for (const days of Object.values(body.schedule)) {
    for (const [date, d] of Object.entries(days)) {
      const open = (d.slots ?? []).filter((s) => s.type === "open" && s.start_time && s.end_time);
      const hours = d.closed
        ? "Closed"
        : open.length
          ? open.map((s) => `${fmt24(s.start_time!.slice(11, 16))} - ${fmt24(s.end_time!.slice(11, 16))}`).join(", ")
          : d.sold_out
            ? "Sold out"
            : "Closed";
      const titles = (d.labels ?? []).map((l) => l.title?.trim()).filter((t): t is string => !!t);
      const events = titles.filter((t) => t.length <= NOTE_LENGTH);
      const notes = titles.filter((t) => t.length > NOTE_LENGTH);
      const loc: LocationHours = {
        kind: "themepark",
        name: cfg.locationName,
        hours,
        ...(notes.length ? { lastEntry: notes.join(" ") } : {}),
        ...(events.length && hours !== "Closed" ? { event: events.join(", ") } : {}),
      };
      snapshot[date] = {
        locations: [loc],
        ...(loc.event ? { event: loc.event } : {}),
      };
    }
  }
  const dates = Object.keys(snapshot).length;
  return { ok: dates > 0, httpStatus: resp.status, snapshot, datesSeen: dates };
}
