export interface DayObs {
  capacity: number;
  available: number;
  used: number;
  packageIds: string;
}

export interface ProductFile {
  park: string;
  product: string;
  generated_at: string;
  days: Record<string, DayObs>;
}

/** Fetch one product's precomputed file from R2 (via the Worker). Returns null
 *  if it's missing or empty — the poller may not cover this product yet. */
export async function loadProduct(
  park: string,
  product: string,
): Promise<ProductFile | null> {
  const r = await fetch(`/calendar/${park}/${product}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as ProductFile;
  return Object.keys(f.days || {}).length > 0 ? f : null;
}
