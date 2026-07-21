import { USER_AGENT, type FirstOptionConfig } from "./config";
import type { RideCatalog } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Paulton's Park queue times, from the First Option Software backend that powers
 * the official app (see docs/paultons-api.md). This is a wholly different source
 * from the Attractions.io live feed the Merlin parks use:
 *   - one flat array, one row per ride (no per-queue-line split, no static/live
 *     merge) — the ride NAME is inline, so there's no content bundle to unzip
 *     and no catalog cron;
 *   - `queueTime` is already in whole MINUTES (the Attractions.io feed was
 *     seconds); values seen: 15, 20. (Verify against an open-park sample — the
 *     first capture was after hours with everything closed.)
 *   - auth is a static app-embedded token sent as the `x-token` header.
 *
 * We normalise each row into the shared `QueueObs` model as a single synthetic
 * queue line keyed by the ride id (Paulton's rides have one queue each), so all
 * the downstream D1 / day-file / Queues-tab machinery is reused unchanged.
 */

interface FosRow {
  rideId?: number;
  statusOpen?: boolean;
  queueTime?: number | null;
  seats?: number | null;
  updatedAt?: string;
  ride?: { name?: string | null } | null;
}

export interface FosFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  /** Ride catalog synthesised from the feed's inline names — persisted to R2 so
   *  the self-heal rebuild and delta-append paths resolve names uniformly, the
   *  same way the Attractions.io parks read their bundle-derived catalog. */
  catalog: RideCatalog;
  linesSeen: number;
}

function emptyCatalog(now: number): RideCatalog {
  return {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "thrill",
    items: {},
    queueLines: {},
  };
}

export async function fetchFirstOptionQueues(
  cfg: FirstOptionConfig,
  now: number,
): Promise<FosFetch> {
  const fail = (httpStatus: number): FosFetch => ({
    ok: false,
    httpStatus,
    snapshot: {},
    catalog: emptyCatalog(now),
    linesSeen: 0,
  });

  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}/api/queue-times`, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-token": cfg.token,
        "is-mobile": "false",
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    return fail(0);
  }
  if (!resp.ok) return fail(resp.status);

  let rows: FosRow[];
  try {
    rows = (await resp.json()) as FosRow[];
  } catch {
    return fail(resp.status);
  }
  if (!Array.isArray(rows)) return fail(resp.status);

  const snapshot: QueueSnapshot = {};
  const catalog = emptyCatalog(now);
  for (const r of rows) {
    if (typeof r.rideId !== "number") continue;
    const rideId = r.rideId;
    const open = r.statusOpen === true;
    // One synthetic "main" line per ride, keyed by the ride id (globally unique,
    // unlike the id-0 degraded convention, so the catalog's line map doesn't
    // collide). Wait is only meaningful while running, so null it when closed —
    // matching the Attractions.io feed (null when shut) and the closed-all-day
    // baseline. Paulton's exposes a single open/closed flag, so open doubles as
    // both is_open and is_operational (running == statusOpen).
    const obs: QueueObs = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: open ? r.queueTime ?? null : null,
      status: null,
      isOpen: open,
      isOperational: open,
    };
    snapshot[`${rideId}:${rideId}`] = obs;

    const name = r.ride?.name?.trim();
    if (name) catalog.items[String(rideId)] = { name };
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };
  }

  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    catalog,
    linesSeen: Object.keys(snapshot).length,
  };
}

/** Whether two catalogs differ in the ride-name set — the only thing that
 *  changes for a First Option park (rides added/renamed/removed). Cheap gate so
 *  the synthetic catalog is only re-written to R2 when it actually changed,
 *  rather than every minute. */
export function catalogNamesChanged(a: RideCatalog | null, b: RideCatalog): boolean {
  if (!a) return true;
  const ak = Object.keys(a.items);
  const bk = Object.keys(b.items);
  if (ak.length !== bk.length) return true;
  for (const k of bk) {
    if (a.items[k]?.name !== b.items[k]?.name) return true;
  }
  return false;
}
