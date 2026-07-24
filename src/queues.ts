import {
  liveFeedUrl,
  USER_AGENT,
  type AttractionsConfig,
  type ParkConfig,
  type QueueSource,
} from "./config";
import {
  appendQueueDeltas,
  closedNote,
  logPoll,
  readQueueLatest,
  updatePollStatus,
  updateQueueIndex,
  writeQueueDayFile,
  writeQueueLatest,
} from "./db";
import { fetchBpbQueues } from "./bpb";
import { fetchFirebaseQueues } from "./firebase";
import { catalogNamesChanged, fetchFirstOptionQueues } from "./firstoption";
import { applyRestrictions, readPaultonsRestrictions } from "./paultons-restrictions";
import { putCatalog, readCatalog, type RideCatalog } from "./rides";
import type { Env, QueueObs, QueueSnapshot } from "./types";

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The live feed's `QueueTime` is in SECONDS (verified against an open park —
 *  values are always multiples of 300, i.e. 5-minute steps), despite the field
 *  name reading like minutes. We store the posted wait in whole minutes. */
const toMinutes = (secs: number | null | undefined): number | null =>
  secs == null ? null : Math.round(secs / 60);

/** London's UTC offset in minutes for a given date (BST → 60, GMT → 0). Used to
 *  put the park's local opening times onto the same minutes-since-UTC-midnight
 *  axis as the samples. */
function londonOffsetMin(date: string): number {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(`${date}T12:00:00Z`)),
  );
  return (h - 12) * 60;
}

/** The park's opening window for the day, as minutes since UTC midnight (to
 *  match the sample axis). Parsed from the live `Resort` record's `OpeningTimes`
 *  (a JSON string of local park times). */
export interface ResortWindow {
  open: number;
  close: number;
}

function parseResortWindow(raw: string | null | undefined): ResortWindow | undefined {
  if (!raw) return undefined;
  let o: { type?: string; start?: string; end?: string };
  try {
    o = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (o.type !== "range" || !o.start || !o.end) return undefined;
  const utcMin = (s: string): number | null => {
    const date = s.slice(0, 10);
    const hh = Number(s.slice(11, 13));
    const mm = Number(s.slice(14, 16));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm - londonOffsetMin(date);
  };
  const open = utcMin(o.start);
  const close = utcMin(o.end);
  if (open == null || close == null || close <= open) return undefined;
  return { open, close };
}

/** One `times.json` entry (see hours.ts). */
interface PaultonsTimesRow {
  open?: string; // "10:00" (24h LOCAL)
  closed?: string; // "17:30"
  dates?: string[];
}

/**
 * Paulton's opening window for a given day, as minutes since UTC midnight — the
 * same axis the queue samples use, so it frames the sparkline exactly like the
 * Attractions.io `Resort` window does for the Merlin parks. Unlike them, the fos
 * queue feed carries no opening times, so we read them from Paulton's own
 * `times.json` (the calendar's structured source). Returns undefined when the
 * day isn't in the file (park closed) or the fetch fails — the caller then falls
 * back to the captured-data span, exactly as before.
 */
export async function fetchPaultonsWindow(
  timesUrl: string,
  date: string,
): Promise<ResortWindow | undefined> {
  let resp: Response;
  try {
    resp = await fetch(timesUrl, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch {
    return undefined;
  }
  if (!resp.ok) return undefined;

  let rows: PaultonsTimesRow[];
  try {
    rows = (await resp.json()) as PaultonsTimesRow[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;

  const row = rows.find((r) => Array.isArray(r.dates) && r.dates.includes(date));
  if (!row?.open || !row?.closed) return undefined;

  const offset = londonOffsetMin(date);
  const toUtcMin = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]) - offset;
  };
  const open = toUtcMin(row.open);
  const close = toUtcMin(row.closed);
  if (open == null || close == null || close <= open) return undefined;
  return { open, close };
}

/** Live feed records. `Item` carries ride-level status (+ an overall wait);
 *  `QueueLine` carries the per-line wait. Both patch onto the static catalog. */
interface LiveItem {
  _id: number;
  IsOpen?: boolean;
  IsOperational?: boolean;
  QueueTime?: number | null;
  QueueStatusMessage?: string | null;
  /** This ride's SCHEDULED opening window today (a JSON string of local park
   *  times, same shape as the `Resort` window). Populated per ride — and often
   *  differs from the park's hours (a ride that opens late / closes early) — so
   *  it's the "ride opening times" the official app shows on the ride page.
   *  Present even while the ride is currently closed. */
  OpeningTimes?: string | null;
}
interface LiveQueueLine {
  _id: number;
  QueueTime?: number | null;
  QueueStatusMessage?: string | null;
}

interface LiveResort {
  OpeningTimes?: string | null;
}

export interface QueueFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  resort?: ResortWindow;
  /** Each ride's own scheduled opening window today (rideId → window), from the
   *  live `Item.OpeningTimes`. Only the Attractions.io backend publishes these;
   *  attached per ride to the day file for the ride-page "opening times". */
  rideWindows?: Record<number, ResortWindow>;
  linesSeen: number;
  /** The feed didn't change since `prevEtag` (HTTP 304) — the caller skips all
   *  parse/diff/writes and just records that it checked. */
  notModified?: boolean;
  /** The feed's current ETag, to persist for next poll's conditional GET. */
  etag?: string | null;
}

/**
 * One stateless read of a park's live queue feed, joined to the static catalog.
 * Per-line wait/status comes from the live `QueueLine` records; ride-level
 * open/operational from the live `Item` records. With no catalog yet (first run
 * before it resolves), degrades to a synthetic ride-level "main" line (id 0) per
 * tracked Item so data still flows — names fill in once the catalog is built.
 */
export async function fetchLiveQueues(
  cfg: AttractionsConfig,
  catalog: RideCatalog | null,
  prevEtag?: string | null,
): Promise<QueueFetch> {
  let resp: Response;
  try {
    resp = await fetch(liveFeedUrl(cfg.apiKey), {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        // Conditional GET: the live feed is edge-cached with a strong ETag, so an
        // unchanged feed answers 304 (0 bytes) and we skip parse+diff+writes.
        ...(prevEtag ? { "if-none-match": prevEtag } : {}),
      },
    });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, linesSeen: 0 };
  }
  // Unchanged since last poll — the caller keeps the existing baseline/day file
  // and just records that it checked.
  if (resp.status === 304) {
    return { ok: true, notModified: true, httpStatus: 304, snapshot: {}, linesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, linesSeen: 0 };
  const etag = resp.headers.get("etag");

  let data: { entities?: Record<string, { records?: unknown[] }> };
  try {
    data = (await resp.json()) as typeof data;
  } catch {
    return { ok: false, httpStatus: resp.status, snapshot: {}, linesSeen: 0 };
  }

  const items = (data.entities?.Item?.records as LiveItem[] | undefined) ?? [];
  const qls = (data.entities?.QueueLine?.records as LiveQueueLine[] | undefined) ?? [];
  const resortRec = (data.entities?.Resort?.records as LiveResort[] | undefined)?.[0];
  const resort = parseResortWindow(resortRec?.OpeningTimes);
  // Each ride's own scheduled window (may open late / close early vs the park).
  // Captured for every Item that carries one, open or closed, so a closed-all-day
  // ride still shows its intended hours.
  const rideWindows: Record<number, ResortWindow> = {};
  for (const it of items) {
    const w = parseResortWindow(it.OpeningTimes);
    if (w) rideWindows[it._id] = w;
  }
  const itemById = new Map(items.map((i) => [i._id, i]));
  const qlById = new Map(qls.map((q) => [q._id, q]));

  const snapshot: QueueSnapshot = {};
  const add = (o: QueueObs) => {
    snapshot[`${o.rideId}:${o.queueLineId}`] = o;
  };

  const staticLines = catalog ? Object.entries(catalog.queueLines) : [];
  // How many static lines each ride has — a single-line ride can fall back to
  // the ride-level (Item) wait when its QueueLine record isn't reporting one.
  const lineCount = new Map<number, number>();
  for (const [, ql] of staticLines) lineCount.set(ql.item, (lineCount.get(ql.item) ?? 0) + 1);

  if (staticLines.length > 0) {
    for (const [qlIdStr, ql] of staticLines) {
      const qlId = Number(qlIdStr);
      const rideId = ql.item;
      const item = itemById.get(rideId);
      const live = qlById.get(qlId);
      const isMain = ql.type.includes("main") || lineCount.get(rideId) === 1;
      const secs = live?.QueueTime ?? (isMain ? item?.QueueTime ?? null : null);
      const status = live?.QueueStatusMessage ?? (isMain ? item?.QueueStatusMessage ?? null : null);
      add({
        rideId,
        queueLineId: qlId,
        lineType: ql.type,
        queueTime: toMinutes(secs),
        status: status ?? null,
        isOpen: item?.IsOpen ?? false,
        isOperational: item?.IsOperational ?? false,
      });
    }
  } else {
    // Degraded mode: no catalog. Treat every Item that reports a QueueTime field
    // as a ride with a single ride-level line (id 0).
    for (const item of items) {
      if (!("QueueTime" in item)) continue;
      add({
        rideId: item._id,
        queueLineId: 0,
        lineType: null,
        queueTime: toMinutes(item.QueueTime),
        status: item.QueueStatusMessage ?? null,
        isOpen: item.IsOpen ?? false,
        isOperational: item.IsOperational ?? false,
      });
    }
  }

  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    resort,
    rideWindows,
    linesSeen: Object.keys(snapshot).length,
    etag,
  };
}

/** A line is "running" (producing a real queue) only when open AND operational.
 *  This is the only open/operational state that matters to us. */
const running = (o: QueueObs): boolean => o.isOpen && o.isOperational;

/**
 * Lines whose posted wait or running-state changed vs the previous snapshot.
 * We compare `running` (open && operational), NOT the two flags separately, and
 * we ignore `QueueStatusMessage` entirely. Both are stored but never surfaced,
 * and parks churn them after close — rides linger `open=0, operational=1` then
 * flip to `operational=0`, and status cycles "BACK SOON"/"CLOSED"/null. Neither
 * changes the running state or anything we display, so counting them added
 * meaningless deltas and kept "last change" ticking long after everything shut.
 *
 * The one exception is a meaningful closed notice — a *scheduled-open* message
 * ("Scheduled to open at 11:00") or a closure reason ("Under maintenance",
 * "Closed all day"): `closedNote` picks it out of the churn, and we log its
 * appearance/withdrawal so a closed ride shows the park's own reason instead of
 * reading as "Closed all day" all morning. It fires a bounded number of times
 * (posted once, withdrawn once), not the endless cycling above.
 */
export function diffQueues(prev: QueueSnapshot, next: QueueSnapshot): QueueObs[] {
  const deltas: QueueObs[] = [];
  for (const [key, n] of Object.entries(next)) {
    const p = prev[key];
    if (
      !p ||
      p.queueTime !== n.queueTime ||
      running(p) !== running(n) ||
      closedNote(p.status) !== closedNote(n.status)
    ) {
      deltas.push(n);
    }
  }
  return deltas;
}

/**
 * One queue poll for one park: resolve the (TTL-cached) catalog, read the live
 * feed, and append only the lines that changed to D1. On any change, refresh the
 * flat diff baseline and regenerate today's served day file from D1.
 */
export async function runQueuePoll(
  env: Env,
  park: ParkConfig & { queue: QueueSource },
): Promise<number> {
  const now = Date.now();
  const observedAt = new Date(now).toISOString();
  const today = ymd(now);

  const prev = await readQueueLatest(env.BUCKET, park.key);

  // Read the live feed for whichever backend this park uses. Both normalise into
  // the same `QueueObs` snapshot + `RideCatalog`, so everything below is shared.
  let res: {
    ok: boolean;
    httpStatus: number;
    snapshot: QueueSnapshot;
    resort?: ResortWindow;
    rideWindows?: Record<number, ResortWindow>;
    linesSeen: number;
    notModified?: boolean;
    etag?: string | null;
  };
  let catalog: RideCatalog | null;
  if (park.queue.kind === "attractions") {
    // Attractions.io: names come from the bundle-derived catalog (built off the
    // hot path by the daily cron); a missing one degrades to unnamed lines. The
    // feed supports conditional GET, so pass the last ETag: an unchanged feed
    // 304s and the whole poll below short-circuits to a status bump.
    catalog = await readCatalog(env.BUCKET, park.key);
    res = await fetchLiveQueues(park.queue, catalog, prev.etag);
  } else {
    // Inline-name backends (First Option / Paulton's, Firestore / Flamingo Land,
    // bespoke / Blackpool): the fetch also hands back a catalog synthesised from
    // the feed. Persist it to R2 (only when the name set changed) so the day-file
    // projection resolves names consistently.
    const synth =
      park.queue.kind === "fos"
        ? await fetchFirstOptionQueues(park.queue, now)
        : park.queue.kind === "firestore"
          ? await fetchFirebaseQueues(park.queue, env.BUCKET, park.key, now)
          : await fetchBpbQueues(park.queue, env, park.key, now);
    res = synth;
    catalog = synth.ok ? synth.catalog : await readCatalog(env.BUCKET, park.key);
    if (synth.ok) {
      // Paulton's restrictions aren't in its feed — fold in the daily-scraped map
      // (see paultons-restrictions.ts) so they ride along on the catalog like the
      // other backends' inline restrictions. Reading before the change-compare
      // means a refreshed map re-persists the catalog (catalogNamesChanged sees
      // the new heights/ages).
      if (park.queue.kind === "fos") {
        const restr = await readPaultonsRestrictions(env.BUCKET, park.key);
        if (restr) applyRestrictions(synth.catalog.items, restr);
      }
      const cached = await readCatalog(env.BUCKET, park.key);
      if (catalogNamesChanged(cached, synth.catalog)) {
        await putCatalog(env.BUCKET, park.key, synth.catalog);
      }
    }
  }

  let changed = 0;
  // `notModified` (conditional-GET 304): the feed is unchanged, so there's
  // nothing to diff or write — fall straight through to the status bump so the
  // page still shows a fresh "checked …" without any parse/diff/R2 work.
  if (res.ok && !res.notModified) {
    const deltas = diffQueues(prev.lines, res.snapshot);
    changed = deltas.length;
    if (changed > 0) {
      await appendQueueDeltas(env.DB, park.key, deltas, observedAt);
      await writeQueueLatest(env.BUCKET, park.key, res.snapshot, observedAt, res.etag);
      // The day's opening window frames the sparkline x-axis. Attractions.io parks
      // carry it in the live feed (res.resort); Paulton's `fos` feed does NOT, so
      // derive it from its own opening-hours times.json.
      const window =
        res.resort ??
        (park.openingHours?.kind === "paultons"
          ? await fetchPaultonsWindow(park.openingHours.timesUrl, today)
          : undefined);
      // Rebuild the served day file from D1 (the delta log is the source of
      // truth). Plenty of CPU headroom to re-project the day each changed poll, so
      // there's no append/drift machinery and no separate self-heal.
      await writeQueueDayFile(
        env.DB,
        env.BUCKET,
        park.key,
        today,
        catalog,
        observedAt,
        window,
        res.rideWindows,
      );
      // Date-nav bounds: only move when a NEW day first gets data (a no-op R2
      // compare within a day), but cheap enough to just keep current here.
      await updateQueueIndex(env.BUCKET, park.key, [today], observedAt);
    } else if (res.etag && res.etag !== prev.etag) {
      // The feed changed only in ways we ignore (post-close status churn), but
      // its ETag advanced. Refresh the baseline ETag so the next poll can 304
      // once the churn settles, instead of re-downloading the feed every minute.
      await writeQueueLatest(env.BUCKET, park.key, res.snapshot, observedAt, res.etag);
    }
  }

  await logPoll(
    env.DB,
    park.key,
    "queues",
    res.httpStatus,
    res.ok ? "OK" : "FAILED",
    changed,
    res.linesSeen,
    observedAt,
  );
  await updatePollStatus(env.BUCKET, park.key, "queues", observedAt, changed > 0);
  return changed;
}
