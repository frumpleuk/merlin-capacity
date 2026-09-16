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

/* ── Queue observations: archived daily, kept for two days ─────────────────────
 *
 * `queue_observation` is the biggest table by a wide margin — every park, every
 * line, every minute the feed moves — and the least useful to keep hot. Nothing
 * reads a past day: `writeQueueDayFile` is the only consumer of these rows and
 * `runQueuePoll` only ever asks it for `today`.
 *
 * Two days are retained rather than one, so a day is archived roughly 28 hours
 * after it ends. That slack costs nothing and means a failed run has a whole
 * further night to succeed before the day it wanted is the oldest thing left.
 */

const QUEUE_RETAIN_DAYS = 2; // today + yesterday stay in D1
const MAX_QUEUE_DAYS_PER_RUN = 3; // bound one invocation; a backlog drains over several nights

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const queueArchiveKey = (park: string, date: string) =>
  `archive/queues/${park}/${date}.ndjson.gz`;

/** Every column, so the archive is the row and not a view of it. Keyset-paged on
 *  (observed_at, ride_id, queue_line_id) — the leading term is the indexed one,
 *  so the day stays a range seek and only the ties within a single timestamp
 *  need ordering. */
const QUEUE_PAGE_SQL = `SELECT park, ride_id, queue_line_id, line_type, queue_time, status,
         is_open, is_operational, observed_at
    FROM queue_observation
   WHERE park = ? AND observed_at >= ? AND observed_at < ?
     AND (observed_at, ride_id, queue_line_id) > (?, ?, ?)
   ORDER BY observed_at, ride_id, queue_line_id
   LIMIT ?`;

const QUEUE_DELETE_SQL = `DELETE FROM queue_observation
   WHERE rowid IN (SELECT rowid FROM queue_observation
                    WHERE park = ? AND observed_at >= ? AND observed_at < ?
                    LIMIT ?)`;

/** Archive one UTC day for one park, then delete it. Returns rows moved, or 0 if
 *  the day was empty. Throws if the archive could not be verified — the caller
 *  stops that park for this run and nothing has been deleted. */
async function archiveQueueDay(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  date: string,
): Promise<number> {
  const from = `${date}T00:00:00.000Z`;
  const to = `${ymd(Date.parse(from) + 86_400_000)}T00:00:00.000Z`;

  const rows = await readPaged(
    db,
    QUEUE_PAGE_SQL,
    [park, from, to],
    ["", -1, -1], // empty string sorts before any timestamp
    (r) => [r.observed_at, r.ride_id, r.queue_line_id],
  );
  if (rows.length === 0) return 0;

  const key = queueArchiveKey(park, date);
  const total = await putArchive(
    bucket,
    key,
    rows,
    (r) => `${r.ride_id}|${r.queue_line_id}|${r.observed_at}`,
  );
  if (!(await verifyArchive(bucket, key, total))) {
    throw new Error(`queue archive ${key} failed verification; nothing deleted`);
  }

  await deleteInBatches(db, QUEUE_DELETE_SQL, [park, from, to]);
  return rows.length;
}

/**
 * Archive and drop every queue day for a park older than the retention window,
 * oldest first, up to `MAX_QUEUE_DAYS_PER_RUN`.
 *
 * Days are found by asking for the oldest `observed_at` still stored, which is a
 * single index seek on (park, observed_at) rather than a DISTINCT over the whole
 * backlog — and re-asking after each delete, so gaps (a day the park was shut,
 * or a day a previous run already took) are skipped for free.
 */
export async function archiveQueues(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  now: number,
): Promise<{ days: string[]; rows: number }> {
  const keepFrom = `${ymd(now - (QUEUE_RETAIN_DAYS - 1) * 86_400_000)}T00:00:00.000Z`;
  const days: string[] = [];
  let rows = 0;

  for (let i = 0; i < MAX_QUEUE_DAYS_PER_RUN; i++) {
    const oldest = await db
      .prepare(`SELECT MIN(observed_at) AS m FROM queue_observation WHERE park = ?`)
      .bind(park)
      .first<{ m: string | null }>();
    const m = oldest?.m;
    if (!m || m >= keepFrom) break; // nothing left outside the retention window

    const date = m.slice(0, 10);
    const moved = await archiveQueueDay(db, bucket, park, date);
    if (moved === 0) break; // can't happen while MIN reports this day; don't spin
    days.push(date);
    rows += moved;
  }

  return { days, rows };
}

/* ── Ticket observations: archived monthly, by the date visited ────────────────
 *
 * Partitioned on `event_date`, NOT on when the row was written. A reading taken
 * in March for a date in December is live data the calendar still serves, so
 * "archive last month's rows" read the natural way would eat the forward window.
 * A ticket row goes cold when the VISIT DATE has passed, whenever it was recorded.
 *
 * Once a month has fully elapsed nothing reads its log rows: the poll path and
 * the anomaly report read `observation_latest`, and `rebuildMonthsFromD1` starts
 * at the current month. Its served month file is already frozen in R2.
 *
 * Two consequences worth being explicit about, because both are load-bearing:
 *
 *   - `observation_latest` is NOT touched here. Its row for an archived date is
 *     the last reading that date ever got, and it stays — that is what keeps a
 *     date the API went quiet on (Chessington 2026-11-20) visible to the anomaly
 *     report and the calendar after the log beneath it has moved to R2.
 *   - the full repair (`/poll`, which rebuilds every month from the log) can no
 *     longer re-derive an archived month. It skips months with no rows rather
 *     than writing an empty file, so the frozen month file survives untouched;
 *     the archive object is the recovery path if one ever needs rebuilding.
 */

const MAX_MONTHS_PER_RUN = 3; // bound one invocation; a backlog drains over a few runs

export const observationArchiveKey = (park: string, product: string, month: string) =>
  `archive/observation/${park}/${product}/${month}.ndjson.gz`;

/** First day of the month after `month` ('2026-07' → '2026-08-01'), as the
 *  exclusive upper bound of a month's dates. */
function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
}

/** Keyset-paged on (event_date, observed_at) — the trailing columns of the
 *  primary key, so this is a pure index walk with no sort at all. */
const OBS_PAGE_SQL = `SELECT park, product, event_date, capacity, available, used,
         package_ids, on_sale, observed_at
    FROM observation
   WHERE park = ? AND product = ? AND event_date >= ? AND event_date < ?
     AND (event_date, observed_at) > (?, ?)
   ORDER BY event_date, observed_at
   LIMIT ?`;

const OBS_DELETE_SQL = `DELETE FROM observation
   WHERE rowid IN (SELECT rowid FROM observation
                    WHERE park = ? AND product = ? AND event_date >= ? AND event_date < ?
                    LIMIT ?)`;

/** Archive one elapsed month for one product, then delete it. Throws without
 *  deleting if the archive cannot be read back. */
async function archiveObservationMonth(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  product: string,
  month: string,
): Promise<number> {
  const from = `${month}-01`;
  const to = monthEnd(month);

  const rows = await readPaged(
    db,
    OBS_PAGE_SQL,
    [park, product, from, to],
    ["", ""],
    (r) => [r.event_date, r.observed_at],
  );
  if (rows.length === 0) return 0;

  const key = observationArchiveKey(park, product, month);
  const total = await putArchive(bucket, key, rows, (r) => `${r.event_date}|${r.observed_at}`);
  if (!(await verifyArchive(bucket, key, total))) {
    throw new Error(`observation archive ${key} failed verification; nothing deleted`);
  }

  await deleteInBatches(db, OBS_DELETE_SQL, [park, product, from, to]);
  return rows.length;
}

/**
 * Archive and drop every fully-elapsed month for one product, oldest first, up to
 * `MAX_MONTHS_PER_RUN`. The current month is never touched — it still has dates
 * ahead of it and `rebuildMonthsFromD1` still projects it from the log.
 *
 * As with the queue job, the oldest month is found via MIN on an indexed column
 * rather than a DISTINCT over the table, and re-asked after each delete so gaps
 * cost nothing.
 */
export async function archiveObservations(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  product: string,
  now: number,
): Promise<{ months: string[]; rows: number }> {
  const currentMonth = new Date(now).toISOString().slice(0, 7);
  const months: string[] = [];
  let rows = 0;

  for (let i = 0; i < MAX_MONTHS_PER_RUN; i++) {
    const oldest = await db
      .prepare(`SELECT MIN(event_date) AS m FROM observation WHERE park = ? AND product = ?`)
      .bind(park, product)
      .first<{ m: string | null }>();
    const m = oldest?.m;
    if (!m) break;

    const month = m.slice(0, 7);
    if (month >= currentMonth) break; // nothing has fully elapsed

    const moved = await archiveObservationMonth(db, bucket, park, product, month);
    if (moved === 0) break;
    months.push(month);
    rows += moved;
  }

  return { months, rows };
}
