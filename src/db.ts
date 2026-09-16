import type { HoursSnapshot } from "./hours";
import type { RideCatalog } from "./rides";
import type { Delta, Product, QueueObs, QueueSnapshot, Snapshot } from "./types";

/** Append changed days to the history log (idempotent per observed_at). */
export async function appendDeltas(
  db: D1Database,
  park: string,
  product: Product,
  deltas: Delta[],
  observedAt: string,
): Promise<void> {
  if (deltas.length === 0) return;
  const log = db.prepare(
    `INSERT OR IGNORE INTO observation
       (park, product, event_date, capacity, available, used, package_ids, on_sale, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The served projection (migration 0007), carried forward in the same batch so
  // it cannot lag the log by a poll. `db.batch` is one transaction, so either both
  // move or neither does.
  //
  // The guard on the update makes the write monotonic: a delayed or replayed poll
  // whose reading is older than what is already stored is ignored rather than
  // rolling the date backwards. Nothing today interleaves two polls of the same
  // product, but the manual /poll endpoint can run alongside the cron, and a
  // silently reordered write here would serve a stale figure indefinitely.
  const latest = db.prepare(
    `INSERT INTO observation_latest
       (park, product, event_date, capacity, available, used, package_ids, on_sale, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (park, product, event_date) DO UPDATE SET
       capacity    = excluded.capacity,
       available   = excluded.available,
       used        = excluded.used,
       package_ids = excluded.package_ids,
       on_sale     = excluded.on_sale,
       observed_at = excluded.observed_at
     WHERE excluded.observed_at > observation_latest.observed_at`,
  );
  const binds = (stmt: D1PreparedStatement, d: Delta) =>
    stmt.bind(
      park,
      product,
      d.date,
      d.capacity,
      d.available,
      d.used,
      d.packageIds,
      d.onSale === undefined ? null : d.onSale ? 1 : 0,
      observedAt,
    );
  await db.batch([
    ...deltas.map((d) => binds(log, d)),
    ...deltas.map((d) => binds(latest, d)),
  ]);
}

export async function logPoll(
  db: D1Database,
  park: string,
  product: Product,
  httpStatus: number,
  apiStatus: string,
  changedCount: number,
  datesSeen: number,
  observedAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO poll_log
         (park, product, http_status, api_status, changed_count, dates_seen, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(park, product, httpStatus, apiStatus, changedCount, datesSeen, observedAt)
    .run();
}

const key = (park: string, product: Product) => `calendar/${park}/${product}.json`;

interface PollStatusFile {
  last_polled: string;
  last_changed: string | null;
}

/**
 * Record a poll's outcome for the frontend's "checked … / last change …" line.
 * `last_polled` bumps on every attempt (so it reflects when we last checked);
 * `last_changed` only advances when this poll actually wrote a delta, so it's
 * preserved read-modify-write across no-change polls. One small file per
 * (park, product) — each product owns its own, so concurrent polls never race.
 */
export async function updatePollStatus(
  bucket: R2Bucket,
  park: string,
  product: Product,
  observedAt: string,
  changed: boolean,
): Promise<void> {
  const objectKey = `status/${park}/${product}.json`;
  // On a CHANGED poll last_changed = now, so the previous value isn't needed —
  // skip the read entirely. Only an unchanged poll (the cheap path anyway) has to
  // read back the stored last_changed to preserve it. Saves an R2 GET on every
  // changed poll, which at peak is most of them.
  let prevChanged: string | null = null;
  if (!changed) {
    const obj = await bucket.get(objectKey);
    if (obj) {
      try {
        prevChanged = ((await obj.json()) as PollStatusFile).last_changed ?? null;
      } catch {
        prevChanged = null;
      }
    }
  }
  const body = JSON.stringify({
    last_polled: observedAt,
    last_changed: changed ? observedAt : prevChanged,
  });
  await bucket.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
}

/**
 * As `updatePollStatus`, but change is detected by comparing a content `hash`
 * to the previously stored one — for products (opening hours) that overwrite
 * wholesale and so have no per-poll delta count. A null hash (failed fetch)
 * bumps `last_polled` only and preserves the stored hash + last_changed.
 */
export async function updatePollStatusHashed(
  bucket: R2Bucket,
  park: string,
  product: Product,
  observedAt: string,
  hash: string | null,
): Promise<void> {
  const objectKey = `status/${park}/${product}.json`;
  let prev: { last_changed?: string | null; hash?: string } = {};
  const obj = await bucket.get(objectKey);
  if (obj) {
    try {
      prev = (await obj.json()) as typeof prev;
    } catch {
      prev = {};
    }
  }
  const changed = hash != null && hash !== prev.hash;
  const body = JSON.stringify({
    last_polled: observedAt,
    last_changed: changed ? observedAt : prev.last_changed ?? null,
    hash: hash ?? prev.hash,
  });
  await bucket.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
}

/** Previous snapshot, read back from the served file — our diff baseline.
 *  R2 is read-after-write consistent, so this reliably reflects the last poll. */
export async function readSnapshot(
  bucket: R2Bucket,
  park: string,
  product: Product,
): Promise<Snapshot> {
  const obj = await bucket.get(key(park, product));
  if (!obj) return {};
  try {
    const data = (await obj.json()) as { days?: Snapshot };
    return data.days ?? {};
  } catch {
    return {};
  }
}

/** The precomputed per-product file the static frontend reads. Each product
 *  owns its own object, so RAP and main polls never race on a shared write. */
export async function writeProductFile(
  bucket: R2Bucket,
  park: string,
  product: Product,
  snapshot: Snapshot,
  generatedAt: string,
  label?: string,
): Promise<void> {
  const body = JSON.stringify({
    park,
    product,
    generated_at: generatedAt,
    ...(label ? { label } : {}),
    days: snapshot,
  });
  await bucket.put(key(park, product), body, {
    httpMetadata: { contentType: "application/json" },
  });
}

/* ── Per-month files (the calendar reads these; enables history) ───────────────
 *
 * The month calendar reads one file per month: `calendar/<park>/<product>/<YYYY-MM>.json`.
 * We write them by merging the current forward snapshot into whatever the month
 * file already holds, so a month FREEZES once its dates leave the forward window:
 *   - a fully-future month: the fetch covers every date → full refresh;
 *   - the current month: the fetch only has today…, so the merge keeps the
 *     earlier-in-month dates already written (their last in-window value = final);
 *   - a fully-past month: never in a fetch again → the file is never rewritten.
 * This mirrors the D1 "last observation per date" history. */

const monthOf = (isoDate: string) => isoDate.slice(0, 7);

/** Group a snapshot by 'YYYY-MM'. */
function byMonth<T>(days: Record<string, T>): Map<string, Record<string, T>> {
  const out = new Map<string, Record<string, T>>();
  for (const [date, v] of Object.entries(days)) {
    const mk = monthOf(date);
    let bucket = out.get(mk);
    if (!bucket) out.set(mk, (bucket = {}));
    bucket[date] = v;
  }
  return out;
}

/** Merge `days` into an existing month file (existing wins for dates not in
 *  `days`, `days` wins for the ones it has) and write it back. */
async function mergeMonthFile<T>(
  bucket: R2Bucket,
  objectKey: string,
  base: Record<string, unknown>,
  days: Record<string, T>,
  generatedAt: string,
): Promise<void> {
  let existing: Record<string, T> = {};
  const obj = await bucket.get(objectKey);
  if (obj) {
    try {
      existing = ((await obj.json()) as { days?: Record<string, T> }).days ?? {};
    } catch {
      existing = {};
    }
  }
  const body = JSON.stringify({
    ...base,
    generated_at: generatedAt,
    days: { ...existing, ...days },
  });
  await bucket.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
}

/**
 * A month's snapshot rebuilt from D1: the LAST observation per event_date in
 * that month. D1 is the source of truth, so the served month file is a pure
 * projection of the log — reproducible and never divergent. Past dates in the
 * current month are included here (they're in the log) even though they've left
 * the forward fetch window.
 */
export async function readMonthSnapshot(
  db: D1Database,
  park: string,
  product: Product,
  month: string,
): Promise<Snapshot> {
  return readRangeSnapshot(db, park, product, `${month}-01`, `${month}-31`);
}

/**
 * The latest recorded state of every date in a range, from the change log.
 *
 * Not the same as the forward product file, which holds only what the LAST poll
 * returned. A date the API stops returning simply vanishes from that file while
 * its history remains here: Chessington 2026-11-20 carries a RAP allocation of
 * 249 in the log and is absent from `calendar/chessington/rap.json` entirely.
 * Anything reasoning about what a park has ever done must read this.
 *
 * This DERIVES the answer by scanning the log, so its cost is every reading ever
 * taken of the dates in the range, not the dates themselves. That is what makes
 * it the right thing for `rebuildMonthsFromD1` — re-deriving the truth is the
 * whole point of a reconciler — and the wrong thing for anything running per
 * poll, which should read the maintained projection via `readLatestRange`.
 */
export async function readRangeSnapshot(
  db: D1Database,
  park: string,
  product: Product,
  start: string,
  end: string,
): Promise<Snapshot> {
  // One indexed pass, not two. The self-join this replaced read the range once to
  // find each date's MAX(observed_at), then read it AGAIN to fetch the matching
  // rows, building a transient index to join them -- and since `observation` is an
  // append-only log, "the range" is every reading ever taken of those dates, not
  // one row per date. Doing that twice, on every changed poll, for every changed
  // month, is a large share of the D1 read bill for what is one scan of work.
  //
  // SQLite resolves bare columns alongside a single MAX() to the row that MAX came
  // from, per GROUP BY group (sqlite.org/lang_select.html#bareagg -- stable since
  // 3.7.11, and D1 is SQLite), so this returns exactly what the join did. The
  // primary key makes (park, product, event_date, observed_at) unique, so there
  // are no ties for the rule to break arbitrarily.
  const { results } = await db
    .prepare(
      `SELECT event_date AS d, capacity, available, used, package_ids, on_sale,
              MAX(observed_at)
         FROM observation
        WHERE park = ? AND product = ? AND event_date >= ? AND event_date <= ?
        GROUP BY event_date`,
    )
    .bind(park, product, start, end)
    .all<{
      d: string;
      capacity: number;
      available: number;
      used: number;
      package_ids: string | null;
      on_sale: number | null;
    }>();

  const snapshot: Snapshot = {};
  for (const r of results) {
    snapshot[r.d] = {
      capacity: r.capacity,
      available: r.available,
      used: r.used,
      packageIds: r.package_ids ?? "",
      // NULL (pre-column history) → undefined → the frontend treats as on sale.
      ...(r.on_sale == null ? {} : { onSale: r.on_sale === 1 }),
    };
  }
  return snapshot;
}

/* ── The served projection (observation_latest, migration 0007) ────────────────
 *
 * `readRangeSnapshot` above derives each date's latest reading by scanning every
 * reading of every date in the range. That is the right thing for the reconciler,
 * which exists to re-derive the truth from the log, but it is the wrong thing to
 * do on every poll: its cost is the readings accumulated so far, so it grows for
 * as long as the collector runs.
 *
 * `observation_latest` holds the same answer as one maintained row per date,
 * upserted by `appendDeltas`. The serving paths read it instead, which makes them
 * cost one row per date and stay flat as the log grows.
 */

/** The latest recorded state of every date in a range, from the projection.
 *  Same result as `readRangeSnapshot`, without the scan. */
export async function readLatestRange(
  db: D1Database,
  park: string,
  product: Product,
  start: string,
  end: string,
): Promise<Snapshot> {
  const { results } = await db
    .prepare(
      `SELECT event_date AS d, capacity, available, used, package_ids, on_sale
         FROM observation_latest
        WHERE park = ? AND product = ? AND event_date >= ? AND event_date <= ?`,
    )
    .bind(park, product, start, end)
    .all<{
      d: string;
      capacity: number;
      available: number;
      used: number;
      package_ids: string | null;
      on_sale: number | null;
    }>();

  const snapshot: Snapshot = {};
  for (const r of results) {
    snapshot[r.d] = {
      capacity: r.capacity,
      available: r.available,
      used: r.used,
      packageIds: r.package_ids ?? "",
      ...(r.on_sale == null ? {} : { onSale: r.on_sale === 1 }),
    };
  }
  return snapshot;
}

/** One month from the projection — `readMonthSnapshot` without the scan. */
export async function readLatestMonth(
  db: D1Database,
  park: string,
  product: Product,
  month: string,
): Promise<Snapshot> {
  return readLatestRange(db, park, product, `${month}-01`, `${month}-31`);
}

/** Which months the product has any date for, from `fromMonth` on — one row per
 *  date instead of per reading, so the month list costs nothing. The projection
 *  never drops a date, so this covers every month the log covers (and, past the
 *  archive horizon, months whose log rows have since moved to R2). */
export async function readLatestMonths(
  db: D1Database,
  park: string,
  product: Product,
  fromMonth?: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT substr(event_date, 1, 7) AS m
         FROM observation_latest
        WHERE park = ? AND product = ? AND event_date >= ?
        ORDER BY m`,
    )
    .bind(park, product, fromMonth ? `${fromMonth}-01` : "0000-00-00")
    .all<{ m: string }>();
  return (results ?? []).map((r) => r.m);
}

/**
 * Re-derive the projection from the log for everything from `fromMonth` on, and
 * correct it where the two disagree.
 *
 * This is what keeps the log the source of truth rather than a write-only
 * sidecar. `appendDeltas` maintains `observation_latest` incrementally, and an
 * incremental projection can drift — a batch that half-applied, a bug in the
 * delta path, a row written directly. Re-deriving it on the same cadence the
 * month files are rebuilt means drift is repaired within half an hour instead of
 * being served indefinitely.
 *
 * Deliberately one statement rather than a read-compare-write from JS: the
 * rebuild is already scanning this exact range of the log for the month files, so
 * the work is shared, and doing it in SQL keeps it atomic. The same monotonic
 * guard as `appendDeltas` applies, so a concurrent poll that has already written
 * something newer wins over this pass.
 */
export async function reconcileLatest(
  db: D1Database,
  park: string,
  product: Product,
  fromMonth?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO observation_latest
         (park, product, event_date, capacity, available, used, package_ids, on_sale, observed_at)
       SELECT park, product, event_date, capacity, available, used, package_ids, on_sale,
              MAX(observed_at)
         FROM observation
        WHERE park = ? AND product = ? AND event_date >= ?
        GROUP BY event_date
       ON CONFLICT (park, product, event_date) DO UPDATE SET
         capacity    = excluded.capacity,
         available   = excluded.available,
         used        = excluded.used,
         package_ids = excluded.package_ids,
         on_sale     = excluded.on_sale,
         observed_at = excluded.observed_at
       WHERE excluded.observed_at > observation_latest.observed_at`,
    )
    .bind(park, product, fromMonth ? `${fromMonth}-01` : "0000-00-00")
    .run();
}


/**
 * Where a rebuild pass takes its numbers from, which is the difference between
 * the two jobs that call it.
 *
 * `"log"` re-derives everything from `observation`, the source of truth: it
 * reconciles the projection first, then reads each month back out of the log. It
 * costs one pass over every forward reading per product (~1.1M rows across the
 * estate), so it runs once a day.
 *
 * `"projection"` reads `observation_latest`, which the poll maintains in the same
 * batch as the log append. One row per date, so a pass is ~1.6k rows and can run
 * every half hour. It cannot detect wrong numbers — that is the daily pass's job
 * — but it does not need to: it exists to put back a month file that was never
 * written, and the projection is the same thing the serving path already trusts.
 */
export type RebuildSource = "log" | "projection";

/**
 * Rebuild a product's month files — every month that has any observation.
 * Self-heals: the per-poll path only (re)writes months whose data changed that
 * poll, so a month whose data has been static since the code deployed (e.g. a
 * quiet RAP allocation) can lack a file. Idempotent; skips empty months.
 *
 * `fromMonth` limits the rebuild to months >= it — the periodic crons pass the
 * current month so they only churn the forward window, never frozen history; a
 * full repair (from `/poll`) omits it to rebuild every month.
 */
export async function rebuildMonthsFromD1(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  product: Product,
  generatedAt: string,
  opts: { source: RebuildSource; fromMonth?: string; label?: string },
): Promise<string[]> {
  const { source, fromMonth, label } = opts;

  // Deep pass only: re-derive the projection from the log and repair any drift
  // (see reconcileLatest). Strictly first, so the month list below reads an
  // already-repaired projection. An INSERT for a date the projection is missing
  // always lands -- the monotonic guard is an ON CONFLICT clause, so it only
  // arbitrates rows that already exist -- which is what makes it safe to take
  // the month list from the projection immediately afterwards.
  if (source === "log") await reconcileLatest(db, park, product, fromMonth);

  // Both passes take the month list from the projection. Asking the log meant a
  // DISTINCT over every reading of every forward date -- 754k rows for one
  // product -- and because DISTINCT builds a temp b-tree on top of the index
  // scan, it read that twice. In the deep pass the reconcile above has just
  // rebuilt the projection from the log, so the list is still log-derived; it is
  // only read from the side that costs one row per date.
  const months = await readLatestMonths(db, park, product, fromMonth);

  const written: string[] = [];
  const present: string[] = [];
  for (const m of months) {
    const snapshot =
      source === "log"
        ? await readMonthSnapshot(db, park, product, m)
        : await readLatestMonth(db, park, product, m);
    // Empty means the log no longer holds the month: `archiveObservations` has
    // moved it to R2, while the projection kept its dates (it never drops one).
    // The month file was frozen before those rows moved, so leaving it untouched
    // is right — and only the full repair reaches back that far anyway, since
    // both crons start at the current month.
    if (Object.keys(snapshot).length === 0) continue;
    present.push(m);
    if (await putMonthFileIfChanged(bucket, park, product, m, snapshot, generatedAt, label)) {
      written.push(m);
    }
  }
  // `present`, not `written`: the index carries the min/max month the park has
  // data for, so a month that exists still sets the bounds even when its file
  // needed no rewrite. Passing `written` would let the bounds drift backwards on
  // a run where everything was already up to date. updateParkIndex is itself a
  // no-op put when the bounds haven't moved, so this stays one Class B get.
  if (present.length) await updateParkIndex(bucket, park, present, generatedAt);
  return written;
}

/** Overwrite one month's product file with a snapshot (from D1). */
export async function putMonthFile(
  bucket: R2Bucket,
  park: string,
  product: Product,
  month: string,
  snapshot: Snapshot,
  generatedAt: string,
  label?: string,
): Promise<void> {
  const body = JSON.stringify({
    park,
    product,
    month,
    generated_at: generatedAt,
    ...(label ? { label } : {}),
    days: snapshot,
  });
  await bucket.put(`calendar/${park}/${product}/${month}.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Field-by-field, rather than comparing serialised JSON: both snapshots are
 *  built from object literals in the same key order today, but that is a
 *  coincidence of how `readLatestRange` and `readRangeSnapshot` happen to be
 *  written, and a reordered literal would silently turn every comparison into a
 *  mismatch — which fails the safe way (a wasted write) but defeats the point. */
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const d of keys) {
    const x = a[d];
    const y = b[d];
    if (!y) return false;
    // `onSale` is absent for products with no anchor and for pre-column history,
    // and both mean "on sale" — so absent and undefined have to compare equal.
    if (
      x.capacity !== y.capacity ||
      x.available !== y.available ||
      x.used !== y.used ||
      x.packageIds !== y.packageIds ||
      (x.onSale ?? null) !== (y.onSale ?? null)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `putMonthFile`, but skip the write when the stored `days` already match.
 * Trades a Class B get for a Class A put, which are priced 12.5:1.
 *
 * Only the rebuild cron uses this. It rewrites every forward month on a fixed
 * cadence and normally finds all of them identical, since `generated_at` is the
 * one field that moved — about 1,250 pointless writes a day. The poll path
 * deliberately does NOT use it: that path only ever writes a month whose data
 * just changed, so the get would always be spent to discover a difference we
 * already knew about.
 *
 * Returns whether it actually wrote.
 */
export async function putMonthFileIfChanged(
  bucket: R2Bucket,
  park: string,
  product: Product,
  month: string,
  snapshot: Snapshot,
  generatedAt: string,
  label?: string,
): Promise<boolean> {
  const obj = await bucket.get(`calendar/${park}/${product}/${month}.json`);
  if (obj) {
    try {
      const cur = (await obj.json()) as { days?: Snapshot; label?: string };
      // The label rides along in the file, so a renamed season has to force the
      // write even when every number is unchanged.
      if (cur.days && cur.label === label && sameSnapshot(cur.days, snapshot)) return false;
    } catch {
      // Unparseable or truncated — fall through and overwrite it.
    }
  }
  await putMonthFile(bucket, park, product, month, snapshot, generatedAt, label);
  return true;
}

/** Write opening hours into per-month files (merged), same freezing behaviour —
 *  so a past month keeps its opening hours and event labels (e.g. "Scarefest"). */
export async function writeHoursMonths(
  bucket: R2Bucket,
  park: string,
  hours: HoursSnapshot,
  generatedAt: string,
): Promise<void> {
  const months = byMonth(hours);
  await Promise.all(
    [...months].map(([mk, days]) =>
      mergeMonthFile(
        bucket,
        `calendar/${park}/hours/${mk}.json`,
        { park, month: mk },
        days,
        generatedAt,
      ),
    ),
  );
}

/* ── Ride queue times ──────────────────────────────────────────────────────────
 *
 * Parallel to the availability stream. `queue_observation` is the delta log
 * (one row per (ride, line) only when its wait/status/open-state moves). The
 * frontend reads one precomputed file per day, `queues/<park>/<date>.json`,
 * regenerated from D1 after each changed poll. The per-poll diff baseline is a
 * small flat snapshot at `queues/<park>/latest.json` (like the availability
 * forward file). */

const queueLatestKey = (park: string) => `queues/${park}/latest.json`;
const queueDayKey = (park: string, date: string) => `queues/${park}/${date}.json`;

/** Append changed queue lines to the history log (idempotent per observed_at). */
export async function appendQueueDeltas(
  db: D1Database,
  park: string,
  deltas: QueueObs[],
  observedAt: string,
): Promise<void> {
  if (deltas.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO queue_observation
       (park, ride_id, queue_line_id, line_type, queue_time, status,
        is_open, is_operational, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    deltas.map((d) =>
      stmt.bind(
        park,
        d.rideId,
        d.queueLineId,
        d.lineType,
        d.queueTime,
        d.status,
        d.isOpen ? 1 : 0,
        d.isOperational ? 1 : 0,
        observedAt,
      ),
    ),
  );
}

/** The last queue snapshot + the upstream feed's ETag at that time, read back
 *  from the flat baseline file. The snapshot is our diff baseline; the `etag`
 *  drives conditional GETs (If-None-Match) so an unchanged feed short-circuits
 *  the whole poll (R2 is read-after-write consistent). */
export async function readQueueLatest(
  bucket: R2Bucket,
  park: string,
): Promise<{ lines: QueueSnapshot; etag: string | null }> {
  const obj = await bucket.get(queueLatestKey(park));
  if (!obj) return { lines: {}, etag: null };
  try {
    const d = (await obj.json()) as { lines?: QueueSnapshot; etag?: string };
    return { lines: d.lines ?? {}, etag: d.etag ?? null };
  } catch {
    return { lines: {}, etag: null };
  }
}

/** Overwrite the flat diff baseline with the current snapshot (+ the feed's
 *  ETag, when the source exposes one, for next poll's conditional GET). */
export async function writeQueueLatest(
  bucket: R2Bucket,
  park: string,
  snapshot: QueueSnapshot,
  generatedAt: string,
  etag?: string | null,
): Promise<void> {
  const body = JSON.stringify({
    park,
    generated_at: generatedAt,
    ...(etag ? { etag } : {}),
    lines: snapshot,
  });
  await bucket.put(queueLatestKey(park), body, {
    httpMetadata: { contentType: "application/json" },
  });
}

interface QueueRow {
  ride_id: number;
  queue_line_id: number;
  line_type: string | null;
  queue_time: number | null;
  status: string | null;
  is_open: number;
  is_operational: number;
  observed_at: string;
}

/** All queue observations for one UTC day, oldest first — the raw intraday
 *  series from which a day file is projected.
 *
 *  Depends on idx_q_park_time (park, observed_at) — see migration 0006. This runs
 *  once per changed poll, per park, every minute, so without an index that seeks
 *  on BOTH columns it degrades to reading everything the park has ever recorded
 *  and the cost of a poll becomes the size of the table. An index on `park` alone
 *  (or one where `observed_at` trails unconstrained columns) does not count. */
async function readQueueDay(
  db: D1Database,
  park: string,
  date: string,
): Promise<QueueRow[]> {
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT ride_id, queue_line_id, line_type, queue_time, status, is_open, is_operational, observed_at
         FROM queue_observation
        WHERE park = ? AND observed_at >= ? AND observed_at < ?
        ORDER BY observed_at ASC`,
    )
    .bind(park, `${date}T00:00:00.000Z`, `${nextDay}T00:00:00.000Z`)
    .all<QueueRow>();
  return results;
}

const LINE_LABELS: Record<string, string> = {
  physical_main: "Main",
  single_rider: "Single Rider",
  virtual: "Virtual Queue",
  fastrack: "Fastrack",
};

const labelForType = (type: string | null): string => {
  if (!type) return "Queue";
  return (
    LINE_LABELS[type] ??
    type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
};

/**
 * A *meaningful* closed notice worth surfacing on a shut ride's row, as opposed
 * to the post-close churn ("BACK SOON"/"CLOSED"/null) we otherwise ignore
 * entirely (see `diffQueues`). Two sources feed this:
 *   - Attractions.io `QueueStatusMessage`s that promise a future opening
 *     ("Scheduled to open at 11:00");
 *   - the reason strings Flamingo Land's `firestore` fetch synthesises from the
 *     feed's own flags ("Under maintenance", "Closed all day").
 * Returns the notice (so the row shows it instead of a bald derived "Closed all
 * day"), or null for everything else. Deliberately narrow — only these phrasings
 * count — so ordinary status cycling still produces no deltas and "last change"
 * doesn't tick after close. Shared by `diffQueues` (what to log) and the day-file
 * projection (what to surface).
 */
export function closedNote(status: string | null): string | null {
  if (!status) return null;
  const s = status.trim();
  return /scheduled to open|opens?\s+(at|from)|opening\s+at|maintenance|closed all day/i.test(s)
    ? s
    : null;
}

/** One queue line in a day file: the day's samples as compact tuples. */
interface QueueLineOut {
  queueLineId: number;
  type: string | null;
  label: string;
  // [minsSinceUtcMidnight, wait|null, open 0/1, operational 0/1]
  samples: [number, number | null, 0 | 1, 0 | 1][];
  // The park's own closed notice, as of the latest sample today — a scheduled
  // opening ("Scheduled to open at 11:00") or a closure reason ("Under
  // maintenance", "Closed all day"). Set only while one is in effect, so the row
  // shows it instead of a derived "Closed all day". Dropped once withdrawn.
  closedNote?: string;
}

/**
 * Project one day's D1 rows into the served day file, joining ride names from the
 * catalog. Re-run from the log (the source of truth) on every changed poll — so
 * it's reproducible and never divergent, with no incremental append to drift.
 */
export async function writeQueueDayFile(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  date: string,
  catalog: RideCatalog | null,
  generatedAt: string,
  resort?: { open: number; close: number },
  rideWindows?: Record<number, { open: number; close: number }>,
): Promise<number> {
  const rows = await readQueueDay(db, park, date);
  const dayStart = Date.parse(`${date}T00:00:00Z`);

  // The park's opening window (minutes since UTC midnight) frames the sparkline
  // x-axis; each ride's own window (rideWindows) is its scheduled hours. Both can
  // be missing from a poll, so we preserve what the existing day file holds:
  //  - park window: preserve when this poll didn't derive one (`!window`).
  //  - per-ride windows: ONLY Attractions.io passes `rideWindows`. When it passes
  //    an EMPTY map (a poll where the feed carried no OpeningTimes), preserve the
  //    ones already on file rather than wiping every ride's hours. A backend that
  //    never publishes them (rideWindows === undefined) has nothing to preserve,
  //    so we don't read the file on its behalf.
  let window = resort;
  let rideWin = rideWindows;
  const preserveRideWin =
    rideWindows !== undefined && Object.keys(rideWindows).length === 0;
  if (!window || preserveRideWin) {
    const existing = await bucket.get(queueDayKey(park, date));
    if (existing) {
      try {
        const e = (await existing.json()) as {
          open?: number;
          close?: number;
          rides?: { id: number; open?: number; close?: number }[];
        };
        if (!window && e.open != null && e.close != null) {
          window = { open: e.open, close: e.close };
        }
        if (preserveRideWin && Array.isArray(e.rides)) {
          const m: Record<number, { open: number; close: number }> = {};
          for (const r of e.rides) {
            if (r.open != null && r.close != null) m[r.id] = { open: r.open, close: r.close };
          }
          rideWin = m;
        }
      } catch {
        /* ignore */
      }
    }
  }

  // ride_id → queue_line_id → line accumulator
  const rides = new Map<number, Map<number, QueueLineOut>>();
  for (const r of rows) {
    let lines = rides.get(r.ride_id);
    if (!lines) rides.set(r.ride_id, (lines = new Map()));
    let line = lines.get(r.queue_line_id);
    if (!line) {
      lines.set(
        r.queue_line_id,
        (line = {
          queueLineId: r.queue_line_id,
          type: r.line_type,
          label: labelForType(r.line_type),
          samples: [],
        }),
      );
    }
    const mins = Math.floor((Date.parse(r.observed_at) - dayStart) / 60_000);
    line.samples.push([mins, r.queue_time, r.is_open ? 1 : 0, r.is_operational ? 1 : 0]);
    // Rows arrive oldest-first, so the last one to touch a line sets the notice;
    // a withdrawal (status back to plain "Closed") clears it. undefined is dropped
    // by JSON.stringify, so the field only appears while a notice is in effect.
    line.closedNote = closedNote(r.status) ?? undefined;
  }

  // Include catalog lines that produced no observation today. Delta-only logging
  // only writes a row when a line's wait/running-state moves, so a ride that has
  // been closed since before midnight generates nothing today and would silently
  // vanish from the list — even though the park's own app still lists it (closed).
  // The park is shut overnight, so any ride that actually ran today has at least
  // its morning open-transition logged; a line with zero same-day rows is
  // therefore closed all day. Seed it with empty samples so it renders as a closed
  // row (rideNow is null when a ride has no running samples).
  if (catalog) {
    for (const [qlIdStr, ql] of Object.entries(catalog.queueLines)) {
      const qlId = Number(qlIdStr);
      // Only seed real, named rides. Lines whose Item isn't in the bundle are
      // stale/soft-launch catalog artifacts ("Ride 12345"); don't fabricate
      // closed entries for them — they still surface if they post live data.
      if (!catalog.items[String(ql.item)]) continue;
      let lines = rides.get(ql.item);
      if (lines?.has(qlId)) continue; // already has real samples
      if (!lines) rides.set(ql.item, (lines = new Map()));
      lines.set(qlId, {
        queueLineId: qlId,
        type: ql.type,
        label: labelForType(ql.type),
        samples: [],
      });
    }
  }

  const ridesOut = [...rides.entries()].map(([rideId, lines]) => {
    const meta = catalog?.items[String(rideId)];
    const win = rideWin?.[rideId];
    return {
      id: rideId,
      name: meta?.name ?? `Ride ${rideId}`,
      ...(meta?.category != null ? { category: meta.category } : {}),
      ...(meta?.group ? { group: meta.group } : {}),
      ...(meta?.groups ? { groups: meta.groups } : {}),
      // Rider restrictions (static, from the catalog). minHeight is in metres for
      // every backend that has any; the rest are Attractions.io-only extras.
      ...(meta?.minHeight != null ? { minHeight: meta.minHeight } : {}),
      ...(meta?.minHeightUnaccompanied != null
        ? { minHeightUnaccompanied: meta.minHeightUnaccompanied }
        : {}),
      ...(meta?.maxHeight != null ? { maxHeight: meta.maxHeight } : {}),
      ...(meta?.maxChest != null ? { maxChest: meta.maxChest } : {}),
      ...(meta?.minAge != null ? { minAge: meta.minAge } : {}),
      ...(meta?.minAgeUnaccompanied != null
        ? { minAgeUnaccompanied: meta.minAgeUnaccompanied }
        : {}),
      // This ride's own scheduled opening window today (minutes since UTC
      // midnight), when the backend publishes it (Attractions.io).
      ...(win ? { open: win.open, close: win.close } : {}),
      named: meta?.name != null, // false → the "unidentified" section
      lines: [...lines.values()].sort((a, b) => a.queueLineId - b.queueLineId),
    };
  });

  const body = JSON.stringify({
    park,
    date,
    generated_at: generatedAt,
    ...(catalog?.groupBy === "land" ? { groupBy: "land" } : {}),
    ...(catalog?.groupDims ? { groupDims: catalog.groupDims } : {}),
    ...(window ? { open: window.open, close: window.close } : {}),
    rides: ridesOut,
  });
  await bucket.put(queueDayKey(park, date), body, {
    httpMetadata: { contentType: "application/json" },
  });
  return ridesOut.length;
}

interface QueueIndex {
  minDate: string;
  maxDate: string;
  generated_at: string;
}

/** Maintain `queues/<park>/index.json` = the [minDate, maxDate] range of days
 *  with queue data, for the frontend's date-nav bounds. Monotonic. */
export async function updateQueueIndex(
  bucket: R2Bucket,
  park: string,
  dates: string[],
  generatedAt: string,
): Promise<void> {
  if (dates.length === 0) return;
  const objectKey = `queues/${park}/index.json`;
  let cur: Partial<QueueIndex> = {};
  const obj = await bucket.get(objectKey);
  if (obj) {
    try {
      cur = (await obj.json()) as Partial<QueueIndex>;
    } catch {
      cur = {};
    }
  }
  const all = [...dates, cur.minDate, cur.maxDate].filter(Boolean) as string[];
  const minDate = all.reduce((a, b) => (b < a ? b : a));
  const maxDate = all.reduce((a, b) => (b > a ? b : a));
  if (minDate === cur.minDate && maxDate === cur.maxDate) return;
  const body = JSON.stringify({ minDate, maxDate, generated_at: generatedAt });
  await bucket.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
}

interface ParkIndex {
  minMonth: string;
  maxMonth: string;
  generated_at: string;
}

/** Maintain `calendar/<park>/index.json` = the [minMonth, maxMonth] range of
 *  months for which data exists, for the frontend's nav bounds. Monotonic: min
 *  only shrinks, max only grows, so concurrent product/hours writers converge. */
export async function updateParkIndex(
  bucket: R2Bucket,
  park: string,
  months: string[],
  generatedAt: string,
): Promise<void> {
  if (months.length === 0) return;
  const objectKey = `calendar/${park}/index.json`;
  let cur: Partial<ParkIndex> = {};
  const obj = await bucket.get(objectKey);
  if (obj) {
    try {
      cur = (await obj.json()) as Partial<ParkIndex>;
    } catch {
      cur = {};
    }
  }
  const all = [...months, cur.minMonth, cur.maxMonth].filter(Boolean) as string[];
  const minMonth = all.reduce((a, b) => (b < a ? b : a));
  const maxMonth = all.reduce((a, b) => (b > a ? b : a));
  if (minMonth === cur.minMonth && maxMonth === cur.maxMonth) return; // no change
  const body = JSON.stringify({ minMonth, maxMonth, generated_at: generatedAt });
  await bucket.put(objectKey, body, { httpMetadata: { contentType: "application/json" } });
}


/* ── Special days (permanent history) ──────────────────────────────────────────
 *
 * A special day can only be detected while its package is still in the catalog.
 * accesso prunes those once the event passes — Alton's 2026-09-06 VodafoneThree
 * package was gone within a week — so a day we identify has to be recorded then
 * or the fact is lost. See migrations/0004_special_days.sql. */

export interface SpecialDayRow {
  event_date: string;
  name: string;
  capacity: number;
  available: number;
  used: number;
}

/**
 * Append today's readings, skipping any that repeat the last one for that date.
 *
 * Diff-on-write like the product log: a buyout is polled daily for months, and
 * only the readings that moved are worth a row. The curve matters most here
 * precisely because it cannot be rebuilt — the package stops returning the date
 * within hours of the event.
 */
export async function upsertSpecialDays(
  db: D1Database,
  park: string,
  days: Record<string, SpecialDayRow>,
  at: string,
): Promise<void> {
  const rows = Object.values(days);
  if (rows.length === 0) return;
  const latest = new Map<string, SpecialDayRow>(
    (await readSpecialDays(db, park)).map((r) => [r.event_date, r]),
  );
  const changed = rows.filter((r) => {
    const p = latest.get(r.event_date);
    return (
      !p ||
      p.name !== r.name ||
      p.capacity !== r.capacity ||
      p.available !== r.available ||
      p.used !== r.used
    );
  });
  if (changed.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO special_day
       (park, event_date, name, capacity, available, used, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    changed.map((r) =>
      stmt.bind(park, r.event_date, r.name, r.capacity, r.available, r.used, at),
    ),
  );
}

/** The latest reading of every special day ever recorded for a park. */
export async function readSpecialDays(
  db: D1Database,
  park: string,
): Promise<SpecialDayRow[]> {
  const { results } = await db
    .prepare(
      `SELECT event_date, name, capacity, available, used, MAX(observed_at)
         FROM special_day
        WHERE park = ?
        GROUP BY event_date
        ORDER BY event_date`,
    )
    .bind(park)
    .all<SpecialDayRow>();
  return results ?? [];
}

/** Every reading of one special day, oldest first: the day's own sales curve. */
export async function readSpecialDayHistory(
  db: D1Database,
  park: string,
  date: string,
): Promise<(SpecialDayRow & { observed_at: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT event_date, name, capacity, available, used, observed_at
         FROM special_day WHERE park = ? AND event_date = ? ORDER BY observed_at`,
    )
    .bind(park, date)
    .all<SpecialDayRow & { observed_at: string }>();
  return results ?? [];
}
