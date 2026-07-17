import { HORIZON_DAYS, type ParkConfig, type ProductConfig } from "./config";
import {
  appendDeltas,
  logPoll,
  putMonthFile,
  readMonthSnapshot,
  readSnapshot,
  updateParkIndex,
  writeProductFile,
} from "./db";
import { resolvePackages } from "./discover";
import { diffSnapshots, fetchProduct } from "./merlin";
import type { Env } from "./types";

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One poll of one product: read the last snapshot (from its R2 file), fetch
 * the live availability, and append only the days that changed to D1. The
 * served file is rewritten only when something moved.
 */
export async function runPoll(
  env: Env,
  park: ParkConfig,
  product: ProductConfig,
): Promise<number> {
  const now = Date.now();
  const observedAt = new Date(now).toISOString();
  const start = ymd(now);
  const end = ymd(now + HORIZON_DAYS * 86_400_000);

  // Resolve the packages to query — hardcoded (RAP) or rediscovered from the
  // catalog (main). No packages means discovery couldn't produce a list and
  // there's no cached fallback; log it and skip rather than sending an empty query.
  const P = await resolvePackages(env.BUCKET, park, product, now);
  if (P.length === 0) {
    await logPoll(env.DB, park.key, product.key, 0, "NO_PACKAGES", 0, 0, observedAt);
    return 0;
  }

  const prev = await readSnapshot(env.BUCKET, park.key, product.key);
  const res = await fetchProduct(park, product, P, start, end);

  let changed = 0;
  if (res.ok) {
    const deltas = diffSnapshots(prev, res.snapshot);
    changed = deltas.length;
    if (changed > 0) {
      await appendDeltas(env.DB, park.key, product.key, deltas, observedAt);
      // The big forward file (diff baseline + drill-down heatmap) …
      await writeProductFile(env.BUCKET, park.key, product.key, res.snapshot, observedAt);
      // … and the per-month calendar files, regenerated from D1 (the source of
      // truth). Only the months this poll actually changed are rebuilt — keeps
      // R2 writes low even with a full-year horizon. A month rebuild pulls the
      // whole month from the log, so the current month keeps its already-past
      // days and past months freeze once they stop receiving deltas.
      const months = [...new Set(deltas.map((d) => d.date.slice(0, 7)))];
      for (const m of months) {
        const monthSnap = await readMonthSnapshot(env.DB, park.key, product.key, m);
        await putMonthFile(env.BUCKET, park.key, product.key, m, monthSnap, observedAt);
      }
      await updateParkIndex(env.BUCKET, park.key, months, observedAt);
    }
  }

  await logPoll(
    env.DB,
    park.key,
    product.key,
    res.httpStatus,
    res.apiStatus,
    changed,
    res.datesSeen,
    observedAt,
  );
  return changed;
}
