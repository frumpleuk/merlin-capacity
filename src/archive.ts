import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";

/*
 * Moving cold rows out of D1 and into R2.
 *
 * D1 is the working set, not the warehouse. Both logs are append-only and both
 * go cold on a schedule the serving paths already respect:
 *
 *   - `queue_observation` is only ever read for TODAY. `writeQueueDayFile` is its
 *     one consumer and `runQueuePoll` only ever asks it for `today`; every past
 *     day is already final at `queues/<park>/<date>.json`.
 *   - `observation` is only read forward. The poll path and the anomaly report
 *     read `observation_latest`, and `rebuildMonthsFromD1` starts at the current
 *     month, so rows for an elapsed month are read by nothing.
 *
 * What the served files DON'T keep is the raw row: a queue day file is a
 * projection that drops the raw `QueueStatusMessage` and rounds `observed_at` to
 * the minute. So the archive stores rows verbatim rather than re-deriving them
 * from what we happen to serve today.
 *
 * Format is gzipped NDJSON — one JSON object per line, one line per D1 row, every
 * column as it was stored. It streams, it concatenates, it reloads a line at a
 * time without parsing the whole object, it diffs usefully, and it compresses
 * hard on this shape (long runs of near-identical rows). `fflate` is already a
 * dependency, so this costs no new supply chain.
 *
 * The invariant throughout: NOTHING IS DELETED FROM D1 THAT HAS NOT BEEN READ
 * BACK OUT OF R2 AND DECODED. Verification re-fetches and decompresses rather
 * than trusting the size or the etag, because the only property worth checking is
 * "this archive can actually be read".
 */

/** One archived D1 row. Values are whatever the column held (TEXT/INTEGER/NULL). */
export type ArchiveRow = Record<string, string | number | null>;

/** Rows → gzipped NDJSON. */
export function encodeNdjson(rows: ArchiveRow[]): Uint8Array {
  return gzipSync(strToU8(rows.map((r) => JSON.stringify(r)).join("\n")), { level: 6 });
}

/** Gzipped NDJSON → rows. Tolerates a trailing newline and an empty object. */
export function decodeNdjson(buf: Uint8Array): ArchiveRow[] {
  const text = strFromU8(gunzipSync(buf));
  if (!text) return [];
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ArchiveRow);
}

/**
 * Write rows to `key`, UNIONed with whatever that object already holds.
 *
 * The union is what makes a re-run safe. A job that archived a day, deleted half
 * of it and then died leaves D1 holding less than the object does; re-archiving
 * from D1 alone would overwrite a complete archive with a partial one and destroy
 * the rows already deleted. Merging on the primary key means a re-run can only
 * ever add, so the object is monotone no matter where a previous run stopped.
 *
 * Returns the row count now in the object.
 */
export async function putArchive(
  bucket: R2Bucket,
  key: string,
  rows: ArchiveRow[],
  primaryKey: (row: ArchiveRow) => string,
): Promise<number> {
  let merged = rows;

  const existing = await bucket.get(key);
  if (existing) {
    const prior = decodeNdjson(new Uint8Array(await existing.arrayBuffer()));
    const byKey = new Map<string, ArchiveRow>();
    for (const r of prior) byKey.set(primaryKey(r), r);
    for (const r of rows) byKey.set(primaryKey(r), r); // fresher row wins a tie
    merged = [...byKey.values()];
  }

  await bucket.put(key, encodeNdjson(merged), {
    // Deliberately NOT contentEncoding: "gzip". These objects are read back by
    // this Worker, and labelling the encoding invites a transport layer to
    // helpfully decompress them somewhere between R2 and `decodeNdjson`. The
    // `.ndjson.gz` suffix documents the format; the metadata stays literal.
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { rows: String(merged.length), archived_at: new Date().toISOString() },
  });
  return merged.length;
}

/**
 * Re-read `key`, decompress it and count the lines. This is the gate in front of
 * every delete — a write that reported success but produced something we cannot
 * decode must not be allowed to authorise dropping the only other copy.
 */
export async function verifyArchive(
  bucket: R2Bucket,
  key: string,
  expectedRows: number,
): Promise<boolean> {
  const obj = await bucket.get(key);
  if (!obj) return false;
  try {
    return decodeNdjson(new Uint8Array(await obj.arrayBuffer())).length === expectedRows;
  } catch {
    return false; // truncated, not gzip, or not NDJSON — treat as no archive at all
  }
}

/**
 * Delete in bounded batches until the predicate matches nothing.
 *
 * `sql` must be a DELETE whose row set is chosen by a subquery ending in
 * `LIMIT ?` — SQLite only accepts `DELETE ... LIMIT` when compiled with
 * SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so bounding it through
 * `WHERE rowid IN (SELECT rowid ... LIMIT ?)` is the portable form. Both logs are
 * ordinary rowid tables, so `rowid` is available on each.
 *
 * Batching keeps a backlog delete (which on first run can be months of rows) from
 * becoming one enormous statement.
 */
export async function deleteInBatches(
  db: D1Database,
  sql: string,
  binds: unknown[],
  batchSize = 2_000,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const res = await db
      .prepare(sql)
      .bind(...binds, batchSize)
      .run();
    const n = res.meta?.changes ?? 0;
    deleted += n;
    if (n < batchSize) return deleted; // includes n === 0
  }
}

/**
 * Read every row a query matches, a page at a time, using keyset pagination.
 *
 * `sql` takes the caller's own binds followed by the cursor columns and a
 * `LIMIT ?`, and must order by exactly those cursor columns. Keyset rather than
 * OFFSET because OFFSET re-walks the skipped rows on every page, which is the
 * same read amplification this whole exercise exists to remove.
 *
 * `firstCursor` is the value the cursor comparison should start below — for a
 * TEXT column, the empty string sorts before everything.
 */
export async function readPaged<T extends ArchiveRow>(
  db: D1Database,
  sql: string,
  binds: unknown[],
  firstCursor: unknown[],
  nextCursor: (row: T) => unknown[],
  pageSize = 5_000,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = firstCursor;
  for (;;) {
    const { results } = await db
      .prepare(sql)
      .bind(...binds, ...cursor, pageSize)
      .all<T>();
    if (!results || results.length === 0) return out;
    out.push(...results);
    if (results.length < pageSize) return out;
    cursor = nextCursor(results[results.length - 1]);
  }
}
