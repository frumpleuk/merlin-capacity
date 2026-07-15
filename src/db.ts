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
