import { parkDay, tzOffsetMin, type OpeningHoursConfig, type Te2Config } from "./config";
import { fmt24, type HoursFetch, type HoursSnapshot } from "./hours";
import type { GroupDim, RideCatalog, RideMeta } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * accesso's TE2 ("The Experience Engine") app platform: Drayton Manor's app
 * (see docs/drayton-api.md). Every read sits behind an anonymous OAuth token
 * from accesso's global-auth server: a client-credentials style POST with the
 * app's own client id and secret (from its Hermes bundle) and the grant type
 * `urn:accesso:oauth2:grant-type:anonymous`. The scope must include
 * `service.all`, or the API answers "Required JWT claim was not asserted".
 *
 * Each grant creates a new guest identity, so the token is cached in R2 and
 * reused until it is near expiry (an hour), never minted per poll.
 *
 * Three reads:
 *   - `pois/status`: live state per POI, `{isOpen, operationalStatus, waitTime}`;
 *   - `pois/`: the catalog (names, Ride Type and height tags, area), refreshed
 *     once a day with today's window;
 *   - `venue-hours` + `calendars/events`: the opening calendar.
 *
 * POI ids are UUIDs and the queue log keys rides by integer, so each id is read
 * as the integer of its first 13 hex digits (52 bits, inside a safe integer).
 */

const tokenKey = (venueId: string) => `te2/${venueId}/token.json`;
const metaKey = (park: string) => `te2/${park}/meta.json`;

/** Mint a fresh token this far before expiry. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** The API caps `days` at 365; the park publishes about two months. */
const HOURS_DAYS = 365;

export const TE2_GROUP_DIMS: GroupDim[] = [
  { key: "type", label: "Type", by: "thrill" },
  { key: "area", label: "Area", by: "land" },
];

/** "05c73a04-a4de-…" → the integer of its first 13 hex digits. */
export function te2RideId(uuid: string): number | null {
  const hex = uuid.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? parseInt(hex.slice(0, 13), 16) : null;
}

/* ── Token ───────────────────────────────────────────────────────────────────── */

interface CachedToken {
  token: string;
  /** Expiry, epoch ms. */
  exp: number;
}

async function mintToken(cfg: Te2Config): Promise<CachedToken | null> {
  let resp: Response;
  try {
    resp = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "dev-tool",
      },
      body: new URLSearchParams({
        grant_type: "urn:accesso:oauth2:grant-type:anonymous",
        scope: "anonymous openid service.all",
      }),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const d = (await resp.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!d?.access_token) return null;
  return { token: d.access_token, exp: Date.now() + (d.expires_in ?? 3600) * 1000 };
}

/** A token with at least five minutes left: the cached one, else a new one,
 *  which is cached. `fresh` skips the cache (after a 401). Without a bucket
 *  (scripts/check-park.ts) every call mints. */
async function getToken(
  cfg: Te2Config,
  bucket: R2Bucket | null,
  fresh = false,
): Promise<string | null> {
  if (bucket && !fresh) {
    const obj = await bucket.get(tokenKey(cfg.venueId));
    const cached = obj ? ((await obj.json().catch(() => null)) as CachedToken | null) : null;
    if (cached?.token && cached.exp - Date.now() > TOKEN_MARGIN_MS) return cached.token;
  }
  const minted = await mintToken(cfg);
  if (!minted) return null;
  await bucket?.put(tokenKey(cfg.venueId), JSON.stringify(minted), {
    httpMetadata: { contentType: "application/json" },
  });
  return minted.token;
}

/** GET a path under `/api/` with the cached token, minting a new one once on a
 *  401. The app also sends `appID` and `X-Customer-ID`. */
async function te2Get(
  cfg: Te2Config,
  bucket: R2Bucket | null,
  path: string,
): Promise<Response | null> {
  const get = (token: string) =>
    fetch(`${cfg.apiUrl}/api/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        appID: cfg.venueId,
        "X-Customer-ID": cfg.customerId,
        accept: "application/json",
        "user-agent": "dev-tool",
      },
    });
  try {
    const token = await getToken(cfg, bucket);
    if (!token) return null;
    const resp = await get(token);
    if (resp.status !== 401) return resp;
    const again = await getToken(cfg, bucket, true);
    return again ? await get(again) : resp;
  } catch {
    return null;
  }
}

/* ── Opening hours ───────────────────────────────────────────────────────────── */

interface VenueHours {
  days?: {
    date?: string;
    hours?: {
      status?: string; // OPEN | CLOSED
      schedule?: { start?: string; end?: string };
    }[];
  }[];
}

interface EventCalendar {
  events?: { id?: string; title?: string }[];
  schedules?: { eventId?: string; start?: string; end?: string }[];
}

/** "2026-10-25T10:30:00Z" → "10:30". The time is the park's wall clock whatever
 *  the suffix: winter dates carry Z, summer ones +01:00. */
const wallClock = (iso: string | undefined) => /T(\d{2}:\d{2})/.exec(iso ?? "")?.[1] ?? null;

/** Each date's OPEN slot as local "HH:MM" pair. A CLOSED day (00:00-23:59) is
 *  left out. */
function openSlots(vh: VenueHours): Map<string, { open: string; close: string }> {
  const out = new Map<string, { open: string; close: string }>();
  for (const d of vh.days ?? []) {
    const slot = d.hours?.find((h) => h.status === "OPEN");
    const open = wallClock(slot?.schedule?.start);
    const close = wallClock(slot?.schedule?.end);
    if (d.date && open && close) out.set(d.date, { open, close });
  }
  return out;
}

/**
 * The park's opening calendar: `venue-hours` gives one slot per date, OPEN or
 * CLOSED, about two months ahead. Closed dates are left out like the other
 * parks. Named events (Blazing Halloween, Magical Christmas) come from the
 * events calendar as date ranges with an exclusive end, and label the open days
 * they cover.
 */
export async function fetchTe2Hours(
  cfg: Extract<OpeningHoursConfig, { kind: "te2" }>,
  bucket: R2Bucket | null,
): Promise<HoursFetch> {
  const fail = (httpStatus: number): HoursFetch => ({ ok: false, httpStatus, snapshot: {}, datesSeen: 0 });
  const [hoursResp, eventsResp] = await Promise.all([
    te2Get(cfg, bucket, `v2/venues/${cfg.venueId}/venue-hours?days=${HOURS_DAYS}`),
    te2Get(cfg, bucket, `v2/venues/${cfg.venueId}/calendars/events?days=${HOURS_DAYS}`),
  ]);
  if (!hoursResp) return fail(0);
  if (!hoursResp.ok) return fail(hoursResp.status);
  const vh = (await hoursResp.json().catch(() => null)) as VenueHours | null;
  if (!vh?.days) return fail(hoursResp.status);

  const snapshot: HoursSnapshot = {};
  for (const [iso, s] of openSlots(vh)) {
    snapshot[iso] = {
      locations: [
        { kind: "themepark", name: cfg.locationName, hours: `${fmt24(s.open)} - ${fmt24(s.close)}` },
      ],
    };
  }

  // Events are a label, so a failed read leaves the hours standing.
  const cal = eventsResp?.ok ? ((await eventsResp.json().catch(() => null)) as EventCalendar | null) : null;
  const titles = new Map((cal?.events ?? []).map((e) => [e.id, e.title?.trim()]));
  for (const s of cal?.schedules ?? []) {
    const title = titles.get(s.eventId);
    const from = s.start?.slice(0, 10);
    const to = s.end?.slice(0, 10);
    if (!title || !from || !to) continue;
    for (const iso of Object.keys(snapshot)) {
      if (iso >= from && iso < to) snapshot[iso].event = title;
    }
  }
  return { ok: true, httpStatus: hoursResp.status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Daily meta: catalog + today's window ────────────────────────────────────── */

interface Tag {
  label?: string;
  valueLabel?: string;
}

interface Poi {
  id?: string;
  label?: string;
  tags?: Tag[] | null;
  details?: { id?: string; value?: { mountainArea?: string } }[] | null;
}

interface Te2Meta {
  /** Park day this was fetched for; a new day triggers a refresh. */
  date: string;
  /** POI uuid → ride metadata, for POIs tagged with a Ride Type. */
  rides: Record<string, RideMeta>;
  /** Today's window (minutes since UTC midnight). Absent on a closed day. */
  window?: { open: number; close: number };
}

/** "1.05m and over" → minHeight 1.05; "Maximum 1.3m" / "Under 0.9m" →
 *  maxHeight; "None" → nothing. */
export function parseTe2Height(v: string | undefined): { minHeight?: number; maxHeight?: number } {
  const m = /(\d+(?:\.\d+)?)\s*m\b/i.exec(v ?? "");
  if (!m) return {};
  const n = Number(m[1]);
  return /maximum|under/i.test(v!) ? { maxHeight: n } : { minHeight: n };
}

function rideMeta(p: Poi): RideMeta | null {
  const tag = (label: string) =>
    p.tags?.find((t) => t.label === label)?.valueLabel?.trim() || undefined;
  const type = tag("Ride Type");
  const name = (p.label ?? "").trim();
  if (!type || !name) return null;
  const area = p.details
    ?.find((d) => d.id === "internalActivity")
    ?.value?.mountainArea?.trim();
  const age = /^(\d+)\+$/.exec(tag("Age Restriction") ?? "");
  return {
    name,
    groups: { type, ...(area ? { area } : {}) },
    ...parseTe2Height(tag("Height Required")),
    ...(age ? { minAge: Number(age[1]) } : {}),
  };
}

async function fetchMeta(
  cfg: Te2Config,
  bucket: R2Bucket | null,
  today: string,
  timeZone: string,
): Promise<Te2Meta | null> {
  const [poisResp, hoursResp] = await Promise.all([
    te2Get(cfg, bucket, `v1/public/venues/${cfg.venueId}/pois/`),
    te2Get(cfg, bucket, `v2/venues/${cfg.venueId}/venue-hours?days=2`),
  ]);
  const pois = poisResp?.ok ? ((await poisResp.json().catch(() => null)) as Poi[] | null) : null;
  if (!Array.isArray(pois)) return null;

  const rides: Te2Meta["rides"] = {};
  for (const p of pois) {
    const meta = p.id ? rideMeta(p) : null;
    if (meta) rides[p.id!] = meta;
  }

  let window: Te2Meta["window"];
  const vh = hoursResp?.ok ? ((await hoursResp.json().catch(() => null)) as VenueHours | null) : null;
  const slot = vh ? openSlots(vh).get(today) : undefined;
  if (slot) {
    const off = tzOffsetMin(today, timeZone);
    const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) - off;
    window = { open: min(slot.open), close: min(slot.close) };
  }
  return { date: today, rides, ...(window ? { window } : {}) };
}

/** Today's meta: the cached copy if it's from today, else a fresh fetch, else
 *  the stale copy minus its window. */
async function loadMeta(
  cfg: Te2Config,
  bucket: R2Bucket | null,
  park: string,
  today: string,
  timeZone: string,
): Promise<Te2Meta | null> {
  const obj = await bucket?.get(metaKey(park));
  const cached = obj ? ((await obj.json().catch(() => null)) as Te2Meta | null) : null;
  if (cached?.date === today) return cached;
  const fresh = await fetchMeta(cfg, bucket, today, timeZone);
  if (fresh) {
    await bucket?.put(metaKey(park), JSON.stringify(fresh), {
      httpMetadata: { contentType: "application/json" },
    });
    return fresh;
  }
  return cached ? { date: cached.date, rides: cached.rides } : null;
}

/* ── Live status ─────────────────────────────────────────────────────────────── */

interface StatusRow {
  id?: string;
  status?: {
    isOpen?: boolean;
    operationalStatus?: string; // OPEN | DOWN | CLOSED | ...
    waitTime?: number | null;
  };
}

export interface Te2Fetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  catalog: RideCatalog;
  resort?: { open: number; close: number };
  linesSeen: number;
}

export async function fetchTe2Queues(
  cfg: Te2Config,
  bucket: R2Bucket | null,
  park: string,
  timeZone: string,
  now: number,
): Promise<Te2Fetch> {
  const catalog: RideCatalog = {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "thrill",
    groupDims: TE2_GROUP_DIMS,
    items: {},
    queueLines: {},
  };
  const fail = (httpStatus: number): Te2Fetch => ({
    ok: false,
    httpStatus,
    snapshot: {},
    catalog,
    linesSeen: 0,
  });

  const today = parkDay(now, timeZone);
  const [meta, resp] = await Promise.all([
    loadMeta(cfg, bucket, park, today, timeZone),
    te2Get(cfg, bucket, `v1/public/venues/${cfg.venueId}/pois/status`),
  ]);
  if (!resp) return fail(0);
  if (!resp.ok) return fail(resp.status);
  // Without the catalog nothing is known to be a ride. Fail the poll and keep
  // the last good state rather than read the park as empty.
  if (!meta) return fail(resp.status);

  const rows = (await resp.json().catch(() => null)) as StatusRow[] | null;
  if (!Array.isArray(rows)) return fail(resp.status);

  const snapshot: QueueSnapshot = {};
  for (const r of rows) {
    const ride = r.id ? meta.rides[r.id] : undefined;
    const rideId = r.id ? te2RideId(r.id) : null;
    if (!ride || rideId == null) continue;
    // Seven rides (Troublesome Trucks, Thor, ...) list no status object at all
    // overnight; six of them are tagged for real-time waits. They read as
    // closed until one does.
    const status = r.status ?? {};

    // Overnight every ride reads operationalStatus OPEN with isOpen false, so
    // OPEN alone doesn't mean running. DOWN is a breakdown: open but not
    // operational, so it counts as downtime.
    const op = (status.operationalStatus ?? "").toUpperCase();
    const running = op === "OPEN" && status.isOpen === true;
    const wait = status.waitTime;
    snapshot[`${rideId}:${rideId}`] = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running && typeof wait === "number" && Number.isFinite(wait) ? Math.max(0, Math.round(wait)) : null,
      status: null,
      isOpen: running || op === "DOWN",
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
