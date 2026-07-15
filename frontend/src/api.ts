export const PARK = "alton_towers";
export const PRODUCTS = ["rap", "main"] as const;
export type Product = (typeof PRODUCTS)[number];

export interface DayObs {
  capacity: number;
  available: number;
  used: number;
  packageIds: string;
}

export interface ProductFile {
  park: string;
  product: Product;
  generated_at: string;
  days: Record<string, DayObs>;
}

/** Fetch each product's precomputed file from R2 (via the Worker). Missing or
 *  empty files are dropped — the poller may not have run for one yet. */
export async function loadProducts(): Promise<ProductFile[]> {
  const files = await Promise.all(
    PRODUCTS.map(async (p) => {
      const r = await fetch(`/calendar/${PARK}/${p}.json`, { cache: "no-store" });
      return r.ok ? ((await r.json()) as ProductFile) : null;
    }),
  );
  return files.filter(
    (f): f is ProductFile => !!f && Object.keys(f.days || {}).length > 0,
  );
}
