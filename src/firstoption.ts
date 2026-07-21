import { USER_AGENT, type FirstOptionConfig } from "./config";
import { PAULTONS_GROUP_DIMS, paultonsGroups } from "./paultons-groups";
import type { RideCatalog } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Paulton's Park queue times, from the First Option Software backend that powers
 * the official app (see docs/paultons-api.md). This is a wholly different source
 * from the Attractions.io live feed the Merlin parks use:
 *   - one flat array, one row per ride (no per-queue-line split, no static/live
 *     merge) — the ride NAME is inline, so there's no content bundle to unzip
 *     and no catalog cron;
 *   - `queueTime` is whole MINUTES (values are multiples of 5, e.g. 5/10/20 —
 *     the Attractions.io feed was seconds), and is **always present**: it's the
 *     ride's LAST-KNOWN wait, not nulled when closed. So it can't signal "open".
 *   - the open/closed signal is `updatedAt` + `statusOpen`, NOT the wait. This is
 *     a last-known-STATE feed (each row = the ride's latest state and WHEN it was
 *     set), not a live instantaneous overlay like Attractions.io.
 *   - auth is a static app-embedded token sent as the `x-token` header.
 *
 * We normalise each row into the shared `QueueObs` model as a single synthetic
 * queue line keyed by the ride id (Paulton's rides have one queue each), so all
 * the downstream D1 / day-file / Queues-tab machinery is reused unchanged. Two
 * rules make the closed/never-ran distinction correct from this feed:
 *   1. Skip DEFUNCT rides — an `updatedAt` older than STALE_DAYS is a removed or
 *      long-closed attraction (the feed still lists ~9 such, e.g. a 2022 date).
 *   2. Only emit a snapshot row for a ride that CHANGED STATE TODAY (`updatedAt`
 *      is today) — that's what "ran today" means here. Current rides that didn't
 *      change today get no row and are seeded as closed-all-day downstream from
 *      the catalog, exactly like an Attractions.io ride with no observations.
 * The residual `queueTime` is kept (not nulled) so a closed-but-ran-today ride
 * carries its last posted wait rather than reading as "closed all day".
 */

/** An `updatedAt` older than this = a defunct/removed attraction the feed still
 *  lists. Dynamic: a seasonally-closed ride reappears once it next changes. */
const STALE_DAYS = 14;

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
    groupDims: PAULTONS_GROUP_DIMS,
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
  const nowDay = new Date(now).toISOString().slice(0, 10);
  const staleBefore = now - STALE_DAYS * 86_400_000;
  for (const r of rows) {
    if (typeof r.rideId !== "number" || !r.updatedAt) continue;
    const upd = Date.parse(r.updatedAt);
    if (!Number.isFinite(upd) || upd < staleBefore) continue; // defunct — skip entirely

    const rideId = r.rideId;
    // Catalog: every CURRENT ride (one synthetic "main" line keyed by the ride
    // id — globally unique, so the catalog's line map doesn't collide). Rides
    // with no row today are seeded closed-all-day from this.
    const name = r.ride?.name?.trim();
    if (name) {
      const groups = paultonsGroups(rideId); // thrill + area from the bundled POI map
      catalog.items[String(rideId)] = { name, ...(groups ? { groups } : {}) };
    }
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };

    // Snapshot: only rides that changed state TODAY (= ran today). `queueTime` is
    // the last-known wait (kept, not nulled); `statusOpen` is the current
    // open/closed state, doubling as is_open and is_operational (one flag).
    if (r.updatedAt.slice(0, 10) !== nowDay) continue;
    const open = r.statusOpen === true;
    snapshot[`${rideId}:${rideId}`] = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: r.queueTime ?? null,
      status: null,
      isOpen: open,
      isOperational: open,
    };
  }

  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    catalog,
    linesSeen: Object.keys(snapshot).length,
  };
}

/** Whether two catalogs differ in the ride name OR group set — the things that
 *  change for a First Option park (rides added/renamed/re-tagged). Cheap gate so
 *  the synthetic catalog is only re-written to R2 when it actually changed,
 *  rather than every minute. Comparing groups too means a deploy that adds/edits
 *  the embedded grouping re-persists the catalog even when names are unchanged. */
export function catalogNamesChanged(a: RideCatalog | null, b: RideCatalog): boolean {
  if (!a) return true;
  const ak = Object.keys(a.items);
  const bk = Object.keys(b.items);
  if (ak.length !== bk.length) return true;
  for (const k of bk) {
    if (a.items[k]?.name !== b.items[k]?.name) return true;
    if (JSON.stringify(a.items[k]?.groups) !== JSON.stringify(b.items[k]?.groups)) return true;
  }
  return false;
}
