import { parkDay, tzOffsetMin, USER_AGENT, type EftelingConfig, type OpeningHoursConfig } from "./config";
import { fmt24, type HoursFetch, type HoursSnapshot } from "./hours";
import type { RideCatalog, RideMeta } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Efteling, from the API behind its app (`api.efteling.com/app/`). Every call
 * carries the app's key (APP_KEY_EFTELING, a Worker secret) and the app's own
 * identifying headers. See docs/efteling-api.md.
 *
 *   - `wis`: every point's live `State` (Dutch) and `WaitingTime`, plus today's
 *     park window (`OpeningHours.Resort`). A ride's single-rider line is its
 *     own row (id = the main row's POI `alternateid`).
 *   - `poi`: names, lands (`empire`), heights (`minimum120`) and which rows are
 *     single-rider lines. Read once a park day.
 * Hours come from the public website (`getpoiinfo/<lang>/<y>/<m>`), no key.
 */

const metaKey = (park: string) => `queues/${park}/efteling-meta.json`;

/** A stable 32-bit number for a word id ("jorisendedraak"): FNV-1a. */
export function eftelingId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function appHeaders(cfg: EftelingConfig): Record<string, string> {
  return {
    accept: "application/json",
    "x-api-key": cfg.apiKey,
    "x-api-version": "9",
    "x-app-version": cfg.appVersion,
    "x-app-name": "Efteling",
    "x-app-id": "nl.efteling.android",
    "x-app-platform": "Android",
    "x-app-language": "en",
    "x-app-timezone": "Europe/Amsterdam",
    "user-agent": "okhttp/5.1.0",
  };
}

/* ── Ride metadata (names, lands, heights, single-rider map) ──────────────────── */

interface PoiFields {
  id?: string;
  name?: string;
  category?: string;
  empire?: string;
  properties?: string[];
  alternatetype?: string;
  alternateid?: string;
}

interface EftelingMeta {
  date: string;
  rides: Record<string, RideMeta>;
  /** Single-rider WIS row id → main ride id. */
  srToMain: Record<string, string>;
}

/** "minimum120" → 1.2. The smallest is the floor to ride at all; a larger one,
 *  if present, is the height to ride without an adult. */
function heights(props: string[] | undefined): Pick<RideMeta, "minHeight" | "minHeightUnaccompanied"> {
  const mins = (props ?? [])
    .map((p) => /^minimum(\d+)$/.exec(p))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]) / 100)
    .sort((a, b) => a - b);
  if (!mins.length) return {};
  return mins.length > 1 ? { minHeight: mins[0], minHeightUnaccompanied: mins[mins.length - 1] } : { minHeight: mins[0] };
}

async function fetchMeta(cfg: EftelingConfig): Promise<Omit<EftelingMeta, "date"> | null> {
  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}poi`, { headers: appHeaders(cfg) });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const body = (await resp.json().catch(() => null)) as { hits?: { hit?: { fields?: PoiFields }[] } } | null;
  const hits = body?.hits?.hit;
  if (!Array.isArray(hits)) return null;

  const rides: EftelingMeta["rides"] = {};
  const srToMain: EftelingMeta["srToMain"] = {};
  for (const h of hits) {
    const f = h.fields;
    const name = f?.name?.trim();
    if (f?.category !== "attraction" || !f.id || !name) continue;
    rides[f.id] = { name, ...(f.empire ? { group: f.empire.trim() } : {}), ...heights(f.properties) };
    if (f.alternatetype === "singlerider" && f.alternateid) srToMain[f.alternateid] = f.id;
  }
  return Object.keys(rides).length ? { rides, srToMain } : null;
}

/** Today's meta: the cached copy if it's from today, else a fresh read, else
 *  the stale copy. */
async function loadMeta(
  cfg: EftelingConfig,
  bucket: R2Bucket | null,
  park: string,
  today: string,
): Promise<EftelingMeta | null> {
  const obj = await bucket?.get(metaKey(park));
  const cached = obj ? ((await obj.json().catch(() => null)) as EftelingMeta | null) : null;
  if (cached?.date === today) return cached;
  const fresh = await fetchMeta(cfg);
  if (fresh) {
    const meta = { date: today, ...fresh };
    await bucket?.put(metaKey(park), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
    return meta;
  }
  return cached ?? null;
}

/* ── Live waits ──────────────────────────────────────────────────────────────── */

interface WisRow {
  Id?: string;
  Type?: string;
  State?: string;
  WaitingTime?: number | null;
}

interface Wis {
  AttractionInfo?: WisRow[];
  OpeningHours?: { Resort?: { HourFrom?: string; HourTo?: string } };
}

/** Dutch live states: running, open but stopped (a breakdown), else closed. */
const RUNNING = "open";
const DOWN = new Set(["tijdelijkbuitenbedrijf", "storing", "wachtrijvol"]);

/** "…T09:30:00+02:00" pair → minutes since `${today}T00:00:00Z`. */
function windowMinutes(
  from: string | undefined,
  to: string | undefined,
  today: string,
  timeZone: string,
): { open: number; close: number } | undefined {
  const t = (iso: string | undefined) => (iso ? /T(\d{2}):(\d{2})/.exec(iso) : null);
  const a = t(from);
  const b = t(to);
  if (!a || !b) return undefined;
  const off = tzOffsetMin(today, timeZone);
  const min = (m: RegExpExecArray) => Number(m[1]) * 60 + Number(m[2]) - off;
  const open = min(a);
  let close = min(b);
  if (close <= open) close += 24 * 60;
  return { open, close };
}

export interface EftelingFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  catalog: RideCatalog;
  resort?: { open: number; close: number };
  linesSeen: number;
}

export async function fetchEftelingQueues(
  cfg: EftelingConfig,
  bucket: R2Bucket | null,
  park: string,
  timeZone: string,
  now: number,
): Promise<EftelingFetch> {
  const catalog: RideCatalog = {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "land",
    items: {},
    queueLines: {},
  };
  const fail = (httpStatus: number): EftelingFetch => ({ ok: false, httpStatus, snapshot: {}, catalog, linesSeen: 0 });

  const today = parkDay(now, timeZone);
  let meta: EftelingMeta | null;
  let resp: Response;
  try {
    [meta, resp] = await Promise.all([
      loadMeta(cfg, bucket, park, today),
      fetch(`${cfg.apiUrl}wis`, { headers: appHeaders(cfg) }),
    ]);
  } catch {
    return fail(0);
  }
  if (!resp.ok) return fail(resp.status);
  if (!meta) return fail(resp.status);
  const wis = (await resp.json().catch(() => null)) as Wis | null;
  if (!wis || !Array.isArray(wis.AttractionInfo)) return fail(resp.status);

  const resort = windowMinutes(wis.OpeningHours?.Resort?.HourFrom, wis.OpeningHours?.Resort?.HourTo, today, timeZone);
  const wait = (w: number | null | undefined) =>
    typeof w === "number" && Number.isFinite(w) && w >= 0 ? Math.round(w) : null;

  const snapshot: QueueSnapshot = {};
  // Live rows keyed by id, so a single-rider row can be read with its main one.
  const byId = new Map<string, WisRow>();
  for (const r of wis.AttractionInfo) if (r.Id) byId.set(r.Id, r);

  for (const [id, ride] of Object.entries(meta.rides)) {
    const rideId = eftelingId(id);
    catalog.items[String(rideId)] = ride;
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };

    const row = byId.get(id);
    const state = (row?.State ?? "").toLowerCase();
    const running = state === RUNNING;
    const down = DOWN.has(state);
    snapshot[`${rideId}:${rideId}`] = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running ? wait(row?.WaitingTime) : null,
      status: null,
      isOpen: running || down,
      isOperational: running,
    } satisfies QueueObs;
  }

  // Single-rider lines: a WIS row whose id maps back to a main ride.
  for (const [srId, mainId] of Object.entries(meta.srToMain)) {
    const row = byId.get(srId);
    if (!row || !meta.rides[mainId]) continue;
    const rideId = eftelingId(mainId);
    const lineId = eftelingId(`${mainId}-sr`);
    const state = (row.State ?? "").toLowerCase();
    const running = state === RUNNING;
    snapshot[`${rideId}:${lineId}`] = {
      rideId,
      queueLineId: lineId,
      lineType: "single_rider",
      queueTime: running ? wait(row.WaitingTime) : null,
      status: null,
      isOpen: running || DOWN.has(state),
      isOperational: running,
    } satisfies QueueObs;
    catalog.queueLines[String(lineId)] = { item: rideId, type: "single_rider" };
  }

  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    catalog,
    ...(resort ? { resort } : {}),
    linesSeen: Object.keys(snapshot).length,
  };
}

/* ── Opening hours (the public website, no key) ──────────────────────────────── */

interface WebDay {
  Date?: string;
  OpeningHours?: { Open?: string; Close?: string }[];
}

/** Fetch one month of the website calendar, or null on any failure. */
async function fetchMonth(cfg: Extract<OpeningHoursConfig, { kind: "efteling" }>, year: number, month: number): Promise<WebDay[] | null> {
  let resp: Response;
  try {
    resp = await fetch(`${cfg.calendarUrl}/en/${year}/${month}`, {
      headers: {
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
        referer: "https://www.efteling.com/en/park/opening-hours?app=true",
        cookie: "website#lang=en",
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const body = (await resp.json().catch(() => null)) as { OpeningHours?: WebDay[] } | null;
  return body?.OpeningHours ?? null;
}

export async function fetchEftelingHours(
  cfg: Extract<OpeningHoursConfig, { kind: "efteling" }>,
): Promise<HoursFetch> {
  const start = new Date();
  const months = Array.from({ length: cfg.months }, (_, i) => {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    return [d.getUTCFullYear(), d.getUTCMonth() + 1] as const;
  });
  const results = await Promise.all(months.map(([y, m]) => fetchMonth(cfg, y, m)));
  // The current month must load; later months are best-effort.
  if (!results[0]) return { ok: false, httpStatus: 0, snapshot: {}, datesSeen: 0 };

  const snapshot: HoursSnapshot = {};
  for (const days of results) {
    for (const d of days ?? []) {
      const date = d.Date?.slice(0, 10);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const slots = (d.OpeningHours ?? []).filter((s) => s.Open && s.Close);
      const hours = slots.length
        ? slots.map((s) => `${fmt24(s.Open!)} - ${fmt24(s.Close!)}`).join(", ")
        : "Closed";
      snapshot[date] = { locations: [{ kind: "themepark", name: cfg.locationName, hours }] };
    }
  }
  const n = Object.keys(snapshot).length;
  return { ok: n > 0, httpStatus: 200, snapshot, datesSeen: n };
}
