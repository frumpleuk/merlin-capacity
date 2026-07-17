import type { HoursSnapshot } from "./hours";
import type { Delta, Product, Snapshot } from "./types";

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
       (park, product, event_date, capacity, available, used, package_ids, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      `SELECT o.event_date AS d, o.capacity, o.available, o.used, o.package_ids
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
    }>();

  const snapshot: Snapshot = {};
  for (const r of results) {
    snapshot[r.d] = {
      capacity: r.capacity,
      available: r.available,
      used: r.used,
      packageIds: r.package_ids ?? "",
    };
  }
  return snapshot;
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
