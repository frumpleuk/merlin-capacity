import { ALTON, HORIZON_DAYS } from "./config";
import { appendDeltas, logPoll, readSnapshot, writeProductFile } from "./db";
import { diffSnapshots, fetchProduct } from "./merlin";
import type { Env, Product } from "./types";

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One poll of one product: read the last snapshot (from its R2 file), fetch
 * the live availability, and append only the days that changed to D1. The
 * served file is rewritten only when something moved.
 */
export async function runPoll(env: Env, product: Product): Promise<number> {
  const now = Date.now();
  const observedAt = new Date(now).toISOString();
  const start = ymd(now);
  const end = ymd(now + HORIZON_DAYS * 86_400_000);

  const prev = await readSnapshot(env.BUCKET, ALTON.park, product);
  const res = await fetchProduct(product, start, end);

  let changed = 0;
  if (res.ok) {
    const deltas = diffSnapshots(prev, res.snapshot);
    changed = deltas.length;
    if (changed > 0) {
      await appendDeltas(env.DB, ALTON.park, product, deltas, observedAt);
      await writeProductFile(env.BUCKET, ALTON.park, product, res.snapshot, observedAt);
    }
  }

  await logPoll(
    env.DB,
    ALTON.park,
    product,
    res.httpStatus,
    res.apiStatus,
    changed,
    res.datesSeen,
    observedAt,
  );
  return changed;
}
