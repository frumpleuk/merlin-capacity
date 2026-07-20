import {
  liveFeedUrl,
  USER_AGENT,
  type AttractionsConfig,
  type ParkConfig,
} from "./config";
import {
  appendQueueDeltas,
  logPoll,
  readQueueLatest,
  updatePollStatus,
  updateQueueIndex,
  writeQueueDayFile,
  writeQueueLatest,
} from "./db";
import { resolveRideCatalog, type RideCatalog } from "./rides";
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

/** Live feed records. `Item` carries ride-level status (+ an overall wait);
 *  `QueueLine` carries the per-line wait. Both patch onto the static catalog. */
interface LiveItem {
  _id: number;
  IsOpen?: boolean;
  IsOperational?: boolean;
  QueueTime?: number | null;
  QueueStatusMessage?: string | null;
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
  linesSeen: number;
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
): Promise<QueueFetch> {
  let resp: Response;
  try {
    resp = await fetch(liveFeedUrl(cfg.apiKey), {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    return { ok: false, httpStatus: 0, snapshot: {}, linesSeen: 0 };
  }
  if (!resp.ok) return { ok: false, httpStatus: resp.status, snapshot: {}, linesSeen: 0 };

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
    linesSeen: Object.keys(snapshot).length,
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
 */
export function diffQueues(prev: QueueSnapshot, next: QueueSnapshot): QueueObs[] {
  const deltas: QueueObs[] = [];
  for (const [key, n] of Object.entries(next)) {
    const p = prev[key];
    if (!p || p.queueTime !== n.queueTime || running(p) !== running(n)) {
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
  park: ParkConfig & { attractions: AttractionsConfig },
): Promise<number> {
  const now = Date.now();
  const observedAt = new Date(now).toISOString();
  const today = ymd(now);

  const catalog = await resolveRideCatalog(env.BUCKET, park.key, park.attractions, now);
  const prev = await readQueueLatest(env.BUCKET, park.key);
  const res = await fetchLiveQueues(park.attractions, catalog);

  let changed = 0;
  if (res.ok) {
    const deltas = diffQueues(prev, res.snapshot);
    changed = deltas.length;
    if (changed > 0) {
      await appendQueueDeltas(env.DB, park.key, deltas, observedAt);
      await writeQueueLatest(env.BUCKET, park.key, res.snapshot, observedAt);
      await writeQueueDayFile(
        env.DB,
        env.BUCKET,
        park.key,
        today,
        catalog,
        observedAt,
        res.resort,
      );
      await updateQueueIndex(env.BUCKET, park.key, [today], observedAt);
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
