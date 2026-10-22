import { tzOffsetMin, type DlpConfig, type OpeningHoursConfig } from "./config";
import { fmt24, type HoursFetch, type HoursSnapshot } from "./hours";
import type { RideCatalog, RideMeta } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Disneyland Paris queue times and opening hours (see docs/disneylandparis-api.md).
 *
 * Two sources, both what the official app (React Native, Hermes bundle) calls:
 *   - the wait feed, an AWS API Gateway GET returning every attraction in both
 *     parks: `{entityId, parkId, status, postedWaitMinutes, singleRider}`. Needs
 *     the app's static `x-api-key`. Minutes arrive as strings.
 *   - the GraphQL API at api.disneylandparis.com, unauthenticated, for ride
 *     names, lands, height limits, and the parks' daily schedules.
 *
 * The feed lists about 24 entity ids the GraphQL catalog has no record of
 * (retired or hidden attractions). The app builds its list from the catalog and
 * looks waits up by id, so those never appear in it, and we drop them too.
 *
 * Entity ids are strings ("P1NA07") and the queue log keys rides by integer, so
 * each id is read as a base-36 number: deterministic and reversible.
 */

const GRAPHQL_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "x-application-id": "mobile-app",
  "user-agent": "dev-tool",
};

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** R2 key for the per-park state refreshed once a day: catalog + today's window. */
const metaKey = (park: string) => `dlp/${park}/meta.json`;

/** "P1NA07" → its base-36 value. Null for anything that isn't 1-8 upper-case
 *  alphanumerics, since `parseInt` would silently stop at the first bad character
 *  and two such ids could collide. Eight characters keeps the single-rider line
 *  id (two more) inside a safe integer. */
export function dlpRideId(entityId: string): number | null {
  return /^[A-Z0-9]{1,8}$/.test(entityId) ? parseInt(entityId, 36) : null;
}

/** The single-rider line's id: the entity id with "SR" appended, so it can't
 *  collide with any ride's own line id. */
const singleRiderLineId = (entityId: string): number => parseInt(`${entityId}SR`, 36);

/** "09:00:00" park-local → minutes since UTC midnight. */
function localToUtcMin(t: string | undefined, offsetMin: number): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) - offsetMin : null;
}

/** "1.20 m" / "81 cm" → metres. "Any Height" and anything else → undefined. */
export function parseDlpHeight(value: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m|cm)\s*$/i.exec(value ?? "");
  if (!m) return undefined;
  const n = Number(m[1].replace(",", "."));
  return m[2].toLowerCase() === "cm" ? n / 100 : n;
}

/* ── GraphQL ─────────────────────────────────────────────────────────────────── */

async function graphql<T>(
  url: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; data: T | null }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: GRAPHQL_HEADERS,
      body: JSON.stringify({ operationName, variables, query }),
    });
  } catch {
    return { status: 0, data: null };
  }
  if (!resp.ok) return { status: resp.status, data: null };
  const body = (await resp.json().catch(() => null)) as { data?: T } | null;
  return { status: resp.status, data: body?.data ?? null };
}

interface Schedule {
  startTime?: string;
  endTime?: string;
  date?: string;
  status?: string;
  closed?: boolean;
}

/** Schedule statuses asked for. OPERATING is the park day; EXTRA_MAGIC_HOURS the
 *  early slot for hotel guests and some passholders. */
const SCHEDULE_TYPES = [
  { type: "ThemePark", status: ["OPERATING", "EXTRA_MAGIC_HOURS", "CLOSED", "REFURBISHMENT"] },
];

/** How far ahead to ask. Disney publishes about ten weeks; dates past that come
 *  back as empty lists, which cost almost nothing. */
const HOURS_HORIZON_DAYS = 150;

/** Every date's ThemePark schedules in ONE request: each date is its own aliased
 *  `activitySchedules` field (d20261021: ...). Returns date to park id to slots, with
 *  only dates Disney has published (an unpublished date is an empty list). */
async function fetchSchedules(
  url: string,
  dates: string[],
): Promise<{ status: number; byDate: Map<string, Map<string, Schedule[]>> | null }> {
  const fields = dates.map(
    (d) =>
      `d${d.replace(/-/g, "")}:activitySchedules(market:$market,date:"${d}",types:$types)` +
      `{id schedules(date:"${d}",types:$types){startTime endTime date status closed}}`,
  );
  const query =
    "query activitySchedules($market:String! $types:[ActivityScheduleStatusInput]!){" +
    fields.join(" ") +
    "}";
  const { status, data } = await graphql<
    Record<string, { id?: string; schedules?: Schedule[] | null }[] | null>
  >(url, "activitySchedules", query, { market: "en-gb", types: SCHEDULE_TYPES });
  if (!data) return { status, byDate: null };

  const byDate = new Map<string, Map<string, Schedule[]>>();
  for (const [alias, parks] of Object.entries(data)) {
    const m = /^d(\d{4})(\d{2})(\d{2})$/.exec(alias);
    if (!m || !parks?.length) continue;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const perPark = new Map<string, Schedule[]>();
    for (const p of parks) {
      if (p.id) perPark.set(p.id, (p.schedules ?? []).filter((s) => s.date === iso));
    }
    byDate.set(iso, perPark);
  }
  return { status, byDate };
}

/* ── Opening hours ───────────────────────────────────────────────────────────── */

const hhmm = (t: string | undefined) => (t ?? "").slice(0, 5);
const slot = (s: Schedule) => `${fmt24(hhmm(s.startTime))} - ${fmt24(hhmm(s.endTime))}`;

/**
 * The park's opening calendar. One themepark row per published date: OPERATING
 * hours, with Extra Magic Time as the note shown after them. A date with only
 * CLOSED slots reads "Closed"; a date Disney hasn't published is left out.
 */
export async function fetchDlpHours(
  cfg: Extract<OpeningHoursConfig, { kind: "dlp" }>,
  now = Date.now(),
): Promise<HoursFetch> {
  const start = Date.parse(`${ymd(now)}T00:00:00Z`);
  const dates = Array.from({ length: HOURS_HORIZON_DAYS }, (_, i) => ymd(start + i * 86_400_000));
  const { status, byDate } = await fetchSchedules(cfg.graphqlUrl, dates);
  if (!byDate) return { ok: false, httpStatus: status, snapshot: {}, datesSeen: 0 };

  const snapshot: HoursSnapshot = {};
  for (const [iso, perPark] of byDate) {
    const slots = perPark.get(cfg.parkId);
    if (!slots?.length) continue;
    const open = slots.find((s) => s.status === "OPERATING" && !s.closed);
    const emt = slots.find((s) => s.status === "EXTRA_MAGIC_HOURS" && !s.closed);
    snapshot[iso] = {
      locations: [
        {
          kind: "themepark",
          name: cfg.locationName,
          hours: open ? slot(open) : "Closed",
          // Shown after the hours on the calendar and in the iCal description.
          ...(open && emt ? { lastEntry: `Extra Magic Time ${slot(emt)}` } : {}),
        },
      ],
    };
  }
  return { ok: true, httpStatus: status, snapshot, datesSeen: Object.keys(snapshot).length };
}

/* ── Daily meta: catalog + today's window ────────────────────────────────────── */

interface DlpMeta {
  /** UTC date this was fetched for; a new date triggers a refresh. */
  date: string;
  /** entityId → ride metadata, for this park's attractions. */
  rides: Record<string, RideMeta & { singleRider?: boolean }>;
  /** Today's window (minutes since UTC midnight), Extra Magic Time included. */
  window?: { open: number; close: number };
  /** Entity ids Disney's schedule has in refurbishment today. The live feed
   *  can't say: it reports every closed ride as REFURBISHMENT, and all of them
   *  after park close. */
  refurb?: string[];
}

interface Attraction {
  id?: string;
  name?: string;
  location?: { id?: string } | null;
  subLocation?: { value?: string } | null;
  singleRider?: boolean | null;
  height?: { value?: string }[] | null;
}

const ATTRACTIONS_QUERY =
  "query attraction($market:String!,$types:[String]){activities(market:$market,types:$types)" +
  "{id name location{id} subLocation{value} ... on Attraction{singleRider height{value}}}}";

/** Attractions Disney's schedule has in refurbishment on a date. */
const REFURB_QUERY =
  "query activitySchedules($market:String! $types:[ActivityScheduleStatusInput]! $date:String!)" +
  "{activitySchedules(market:$market,date:$date,types:$types){id}}";

async function readMeta(bucket: R2Bucket, park: string): Promise<DlpMeta | null> {
  const obj = await bucket.get(metaKey(park));
  if (!obj) return null;
  try {
    return (await obj.json()) as DlpMeta;
  } catch {
    return null;
  }
}

/** Fetch this park's attractions and today's schedule. Null if the catalog
 *  request fails (a missing window alone isn't a failure). */
async function fetchMeta(cfg: DlpConfig, today: string, timeZone: string): Promise<DlpMeta | null> {
  const [cat, sched, refurb] = await Promise.all([
    graphql<{ activities?: Attraction[] }>(cfg.graphqlUrl, "attraction", ATTRACTIONS_QUERY, {
      market: "en-gb",
      types: ["Attraction"],
    }),
    fetchSchedules(cfg.graphqlUrl, [today]),
    graphql<{ activitySchedules?: { id?: string }[] }>(cfg.graphqlUrl, "activitySchedules", REFURB_QUERY, {
      market: "en-gb",
      date: today,
      types: [{ type: "Attraction", status: ["REFURBISHMENT"] }],
    }),
  ]);
  const list = cat.data?.activities;
  if (!list?.length) return null;

  const rides: DlpMeta["rides"] = {};
  // Disney lists a few rides under two ids with the same name and the same wait
  // (Main Street Station is P1MA01 and P1MA05). Keep the lowest id per name, so
  // the list has one row per ride.
  const seen = new Set<string>();
  const sorted = [...list].sort((x, y) => (x.id ?? "").localeCompare(y.id ?? ""));
  for (const a of sorted) {
    if (!a.id || a.location?.id !== cfg.parkId) continue;
    // Some names carry a trailing zero-width space.
    const name = (a.name ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const land = (a.subLocation?.value ?? "").trim();
    const minHeight = parseDlpHeight(a.height?.[0]?.value);
    rides[a.id] = {
      name,
      ...(land ? { group: land } : {}),
      ...(minHeight != null ? { minHeight } : {}),
      ...(a.singleRider ? { singleRider: true } : {}),
    };
  }

  let window: DlpMeta["window"];
  const slots = sched.byDate?.get(today)?.get(cfg.parkId)?.filter((s) => !s.closed) ?? [];
  if (slots.length) {
    const off = tzOffsetMin(today, timeZone);
    const opens = slots.map((s) => localToUtcMin(s.startTime, off)).filter((n) => n != null);
    const closes = slots.map((s) => localToUtcMin(s.endTime, off)).filter((n) => n != null);
    if (opens.length && closes.length) {
      window = { open: Math.min(...opens), close: Math.max(...closes) };
    }
  }
  const refurbIds = (refurb.data?.activitySchedules ?? []).map((a) => a.id).filter((id): id is string => !!id);
  return { date: today, rides, ...(window ? { window } : {}), refurb: refurbIds };
}

/** Today's meta: the cached copy if it's from today, else a fresh fetch, else
 *  the stale copy minus its window (yesterday's window is wrong for today). */
async function loadMeta(
  cfg: DlpConfig,
  bucket: R2Bucket,
  park: string,
  today: string,
  timeZone: string,
): Promise<DlpMeta | null> {
  const cached = await readMeta(bucket, park);
  // A copy from before `refurb` existed is refetched once.
  if (cached?.date === today && cached.refurb) return cached;
  const fresh = await fetchMeta(cfg, today, timeZone);
  if (fresh) {
    await bucket.put(metaKey(park), JSON.stringify(fresh), {
      httpMetadata: { contentType: "application/json" },
    });
    return fresh;
  }
  return cached ? { date: cached.date, rides: cached.rides } : null;
}

/* ── Wait feed ───────────────────────────────────────────────────────────────── */

interface WaitRow {
  entityId?: string;
  parkId?: string; // "0/P/P1"
  status?: string; // OPERATING | DOWN | REFURBISHMENT | CLOSED
  postedWaitMinutes?: string;
  singleRider?: { isAvailable?: boolean; singleRiderWaitMinutes?: string };
}

export interface DlpFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  catalog: RideCatalog;
  resort?: { open: number; close: number };
  linesSeen: number;
}

const minutes = (s: string | undefined): number | null => {
  const n = Number(s);
  return s != null && s !== "" && Number.isFinite(n) ? Math.round(n) : null;
};

export async function fetchDlpQueues(
  cfg: DlpConfig,
  bucket: R2Bucket,
  park: string,
  timeZone: string,
  now: number,
): Promise<DlpFetch> {
  const catalog: RideCatalog = {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "land",
    items: {},
    queueLines: {},
  };
  const fail = (httpStatus: number): DlpFetch => ({
    ok: false,
    httpStatus,
    snapshot: {},
    catalog,
    linesSeen: 0,
  });

  const today = ymd(now);
  const [meta, resp] = await Promise.all([
    loadMeta(cfg, bucket, park, today, timeZone),
    fetch(cfg.waitTimesUrl, {
      headers: { accept: "application/json", "x-api-key": cfg.apiKey, "user-agent": "dev-tool" },
    }).catch(() => null),
  ]);
  if (!resp) return fail(0);
  if (!resp.ok) return fail(resp.status);
  // Without names every row would be dropped, which would read as the whole
  // park vanishing. Fail the poll instead and keep the last good state.
  if (!meta) return fail(resp.status);

  let rows: WaitRow[];
  try {
    rows = (await resp.json()) as WaitRow[];
  } catch {
    return fail(resp.status);
  }
  if (!Array.isArray(rows)) return fail(resp.status);

  const refurb = new Set(meta.date === today ? meta.refurb ?? [] : []);
  const snapshot: QueueSnapshot = {};
  for (const r of rows) {
    const id = r.entityId ?? "";
    if (r.parkId !== `0/P/${cfg.parkId}`) continue;
    const ride = meta.rides[id];
    const rideId = dlpRideId(id);
    if (!ride || rideId == null) continue;

    const status = (r.status ?? "").toUpperCase();
    const running = status === "OPERATING";
    // DOWN is a breakdown: open but not operational, so it counts as downtime.
    const isOpen = running || status === "DOWN";
    // The feed's REFURBISHMENT just means closed (every ride reads it after
    // close), so the note comes from Disney's refurbishment schedule. The
    // closed-notice logic files it as maintenance.
    const note = !isOpen && refurb.has(id) ? "Refurbishment" : null;

    const main: QueueObs = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running ? minutes(r.postedWaitMinutes) : null,
      status: note,
      isOpen,
      isOperational: running,
    };
    snapshot[`${rideId}:${rideId}`] = main;
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };

    const { singleRider: hasSingleRider, ...metaFields } = ride;
    catalog.items[String(rideId)] = metaFields;

    if (hasSingleRider) {
      const lineId = singleRiderLineId(id);
      const srOpen = running && r.singleRider?.isAvailable === true;
      snapshot[`${rideId}:${lineId}`] = {
        ...main,
        queueLineId: lineId,
        lineType: "single_rider",
        queueTime: srOpen ? minutes(r.singleRider?.singleRiderWaitMinutes) : null,
        isOpen: srOpen,
        isOperational: srOpen,
      };
      catalog.queueLines[String(lineId)] = { item: rideId, type: "single_rider" };
    }
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
