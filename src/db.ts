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
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO observation
       (park, product, event_date, capacity, available, used, package_ids, on_sale, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    deltas.map((d) =>
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
      ),
    ),
  );
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
): Promise<void> {
  const body = JSON.stringify({
    park,
    product,
    generated_at: generatedAt,
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
  const start = `${month}-01`;
  const end = `${month}-31`; // string compare: '-31' >= any real day, < next month
  const { results } = await db
    .prepare(
      `SELECT o.event_date AS d, o.capacity, o.available, o.used, o.package_ids, o.on_sale
         FROM observation o
         JOIN (SELECT event_date, MAX(observed_at) AS mx
                 FROM observation
                WHERE park = ? AND product = ? AND event_date >= ? AND event_date <= ?
                GROUP BY event_date) L
           ON o.event_date = L.event_date AND o.observed_at = L.mx
        WHERE o.park = ? AND o.product = ? AND o.event_date >= ? AND o.event_date <= ?`,
    )
    .bind(park, product, start, end, park, product, start, end)
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

/**
 * Rebuild a product's month files from the D1 log — every month that has any
 * observation. Self-heals: the per-poll path only (re)writes months whose data
 * changed that poll, so a month whose data has been static since the code
 * deployed (e.g. a quiet RAP allocation) can lack a file. This regenerates them
 * from the source of truth. Idempotent; skips empty months.
 *
 * `fromMonth` limits the rebuild to months >= it — the periodic cron passes the
 * current month so it only churns the forward window, never frozen history; a
 * full repair (from `/poll`) omits it to rebuild every month.
 */
export async function rebuildMonthsFromD1(
  db: D1Database,
  bucket: R2Bucket,
  park: string,
  product: Product,
  generatedAt: string,
  fromMonth?: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT substr(event_date, 1, 7) AS m
         FROM observation
        WHERE park = ? AND product = ? AND substr(event_date, 1, 7) >= ?
        ORDER BY m`,
    )
    .bind(park, product, fromMonth ?? "0000-00")
    .all<{ m: string }>();

  const written: string[] = [];
  for (const { m } of results) {
    const snapshot = await readMonthSnapshot(db, park, product, m);
    if (Object.keys(snapshot).length === 0) continue;
    await putMonthFile(bucket, park, product, m, snapshot, generatedAt);
    written.push(m);
  }
  if (written.length) await updateParkIndex(bucket, park, written, generatedAt);
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
): Promise<void> {
  const body = JSON.stringify({
    park,
    product,
    month,
    generated_at: generatedAt,
    days: snapshot,
  });
  await bucket.put(`calendar/${park}/${product}/${month}.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
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
 *  series from which a day file is projected. */
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
