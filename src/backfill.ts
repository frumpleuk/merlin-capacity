import { decodeNdjson, queueArchiveKey } from "./archive";
import { queueParks } from "./config";
import { writeQueueDayFile, type QueueRow } from "./db";
import { readCatalog } from "./rides";
import type { Env } from "./types";

/* ── Re-projecting past days ──────────────────────────────────────────────────
 *
 * `writeQueueDayFile` only ever runs for TODAY — the queue poll is its only
 * caller — so a change to what the projection keeps applies from the day it
 * ships and no further back. That was fine while the projection only rearranged
 * what the file already held. It stopped being fine when the file started
 * carrying the day's closure notices: every past day still says only what was in
 * effect at the final poll, so a maintenance window withdrawn before close, and
 * every seasonal closure the park announced and then lifted, are missing from
 * history even though we recorded them at the time.
 *
 * We did record them. `queue_observation.status` holds the park's own words for
 * every row, and the nightly archive copies every column into
 * `archive/queues/<park>/<date>.ndjson.gz` — the archive is the row, not a view
 * of it, precisely so that this is possible. So a past day can be rebuilt
 * exactly as today's would be: decode the archive, hand the rows to the same
 * projection, write the same file.
 *
 * Bounded per run and driven from the daily stats cron, so the backlog drains
 * over a few nights the way the archive's own does, and re-running is free once
 * it has (a day already at the current projection version is skipped).
 */

/** Day files at or above this are already projected by the current code. */
const CURRENT_VERSION = 2;

/** One run's budget. Each day is an R2 get of the archive, a get of the existing
 *  file, a gunzip and a put; a few dozen is comfortable inside a cron. */
const MAX_DAYS_PER_RUN = 30;

export interface BackfillResult {
  rebuilt: string[];
  /** Days whose archive isn't there — the rows aged out before the archive job
   *  existed, or the park was shut. Nothing to do, and we say so rather than
   *  retrying them every night. */
  missing: number;
  skipped: number;
}

/** Has this day file already been projected by the current code? */
async function versionOf(bucket: R2Bucket, park: string, date: string): Promise<number | null> {
  const obj = await bucket.get(`queues/${park}/${date}.json`);
  if (!obj) return null;
  try {
    const f = (await obj.json()) as { v?: number };
    return f.v ?? 1;
  } catch {
    return null;
  }
}

/** The archive stores every column as D1 held it; narrow it back to the shape
 *  the projection reads. Rows are written in (observed_at, ride, line) order and
 *  the projection depends on that ordering, so it is restored rather than
 *  assumed — a re-encoded or concatenated archive would otherwise break the
 *  notice runs silently. */
function toQueueRows(rows: Record<string, string | number | null>[]): QueueRow[] {
  return rows
    .map((r) => ({
      ride_id: Number(r.ride_id),
      queue_line_id: Number(r.queue_line_id),
      line_type: (r.line_type ?? null) as string | null,
      queue_time: r.queue_time == null ? null : Number(r.queue_time),
      status: (r.status ?? null) as string | null,
      is_open: Number(r.is_open),
      is_operational: Number(r.is_operational),
      observed_at: String(r.observed_at),
    }))
    .sort(
      (a, b) =>
        a.observed_at.localeCompare(b.observed_at) ||
        a.ride_id - b.ride_id ||
        a.queue_line_id - b.queue_line_id,
    );
}

/**
 * Rebuild one park-day's file from its archive. Returns false when there's
 * nothing to rebuild from.
 *
 * The park window and the per-ride hours aren't in the archive — they come from
 * the live feed, not from D1 — so they're preserved from the existing file:
 * passing no `resort` and an empty `rideWindows` map is exactly the signal
 * `writeQueueDayFile` already uses for "this poll derived none, keep what's on
 * file". A backfill therefore never loses a ride's published hours.
 */
export async function backfillQueueDay(
  env: Env,
  park: string,
  date: string,
): Promise<boolean> {
  const obj = await env.BUCKET.get(queueArchiveKey(park, date));
  if (!obj) return false;
  let rows: QueueRow[];
  try {
    rows = toQueueRows(decodeNdjson(new Uint8Array(await obj.arrayBuffer())));
  } catch {
    return false;
  }
  if (rows.length === 0) return false;

  // Names come from the catalog, not the archive. Without one the projection
  // would write `Ride 3840` over every name and mark them all unnamed, which
  // the stats then skip entirely — a rebuild must never make a day worse than
  // it found it.
  const catalog = await readCatalog(env.BUCKET, park);
  if (!catalog) return false;

  await writeQueueDayFile(
    env.DB,
    env.BUCKET,
    park,
    date,
    catalog,
    // Stamp it as a rebuild rather than claiming the original poll's time: the
    // samples are the day's, the projection is now.
    new Date().toISOString(),
    undefined, // park window: preserve whatever the file has
    {}, // ride windows: likewise (empty map = preserve, see writeQueueDayFile)
    rows,
  );
  return true;
}

/**
 * Walk back from yesterday, rebuilding any day file older than the current
 * projection version, for every queue park. Oldest-first would leave the most
 * recent — the days anyone is actually looking at — until last, so this goes
 * newest-first.
 */
export async function backfillQueueDays(
  env: Env,
  now: number,
  lookbackDays = 400,
  budget = MAX_DAYS_PER_RUN,
): Promise<Record<string, BackfillResult>> {
  const out: Record<string, BackfillResult> = {};
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  for (const park of queueParks()) {
    const res: BackfillResult = { rebuilt: [], missing: 0, skipped: 0 };
    out[park.key] = res;
    for (let i = 1; i <= lookbackDays; i++) {
      if (res.rebuilt.length >= budget) break;
      const date = ymd(now - i * 86_400_000);
      const v = await versionOf(env.BUCKET, park.key, date);
      if (v == null) continue; // no day file: park shut, or before we tracked it
      if (v >= CURRENT_VERSION) {
        res.skipped++;
        continue;
      }
      try {
        if (await backfillQueueDay(env, park.key, date)) res.rebuilt.push(date);
        else res.missing++;
      } catch (err) {
        console.error(`backfill failed for ${park.key}/${date}:`, err);
      }
    }
  }
  return out;
}
