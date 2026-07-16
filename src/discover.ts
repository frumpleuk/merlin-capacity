import {
  bootstrapUrl,
  DISCOVERY_TTL_MS,
  USER_AGENT,
  type DiscoverSpec,
  type ParkConfig,
  type ProductConfig,
} from "./config";

/** One package as it appears in the bootstrap catalog (fields we use). accesso
 *  serves `E`/`CT` as a bare object when there's one, an array when there are
 *  several. */
type OneOrMany<T> = T | T[] | undefined;
interface CatalogPackage {
  id: string;
  name?: string;
  package_class?: string;
  E?: OneOrMany<{ id?: string }>;
  CT?: OneOrMany<{ id?: string }>;
}

const asArray = <T>(v: OneOrMany<T>): T[] =>
  Array.isArray(v) ? v : v ? [v] : [];

interface Bootstrap {
  GetMerchantPackageList?: { SERVICE?: { PS?: { P?: CatalogPackage[] } } };
}

interface CachedList {
  generated_at: string;
  P: unknown[];
}

const cacheKey = (park: string, product: string) => `catalog/${park}/${product}.json`;

/**
 * The package selectors to send to GetMerchantPackageEventDates for a product:
 * a hardcoded `P` as-is (RAP — not in the catalog), or a list rediscovered from
 * the park's public bootstrap catalog and cached in R2 on a TTL (main tickets).
 * Never throws; on catalog failure it falls back to the last cached list.
 */
export async function resolvePackages(
  bucket: R2Bucket,
  park: ParkConfig,
  product: ProductConfig,
  now: number,
): Promise<unknown[]> {
  if (product.P) return product.P;
  if (!product.discover) return [];
  return discoverPackages(bucket, park, product, product.discover, now);
}

async function discoverPackages(
  bucket: R2Bucket,
  park: ParkConfig,
  product: ProductConfig,
  spec: DiscoverSpec,
  now: number,
): Promise<unknown[]> {
  const key = cacheKey(park.key, product.key);
  const cached = await readCache(bucket, key);
  if (cached && now - Date.parse(cached.generated_at) < DISCOVERY_TTL_MS) {
    return cached.P;
  }

  const fresh = await fetchCatalogPackages(park, spec);
  if (fresh.length === 0) {
    // Catalog down, wrong slug, or park mid-rotation — keep serving the last
    // good list rather than letting the poll fail with no packages.
    return cached?.P ?? [];
  }

  const body: CachedList = { generated_at: new Date(now).toISOString(), P: fresh };
  await bucket.put(key, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  return fresh;
}

async function readCache(bucket: R2Bucket, key: string): Promise<CachedList | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    const d = (await obj.json()) as Partial<CachedList>;
    if (!Array.isArray(d.P) || !d.generated_at) return null;
    return { generated_at: d.generated_at, P: d.P };
  } catch {
    return null;
  }
}

/** Fetch the bootstrap catalog and build the P[] for the matching packages. */
async function fetchCatalogPackages(
  park: ParkConfig,
  spec: DiscoverSpec,
): Promise<unknown[]> {
  let resp: Response;
  try {
    resp = await fetch(bootstrapUrl(park.bootstrapSlug), {
      headers: {
        accept: "application/json, text/plain, */*",
        origin: park.origin,
        referer: `${park.origin}/`,
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    return [];
  }
  if (!resp.ok) return [];

  let data: Bootstrap;
  try {
    data = (await resp.json()) as Bootstrap;
  } catch {
    return [];
  }

  const packages = data.GetMerchantPackageList?.SERVICE?.PS?.P;
  if (!Array.isArray(packages)) return [];

  const wantClass = spec.packageClass ?? "Daily Tickets";
  const wantName = spec.name ?? "1 Day Ticket";
  const out: unknown[] = [];
  for (const p of packages) {
    if (p.package_class !== wantClass) continue;
    if ((p.name ?? "").trim() !== wantName) continue;
    if (!asArray(p.E).some((e) => e.id === spec.event_id)) continue;
    if (!asArray(p.CT).some((c) => c.id === spec.customerType)) continue;
    out.push({
      CT: [{ id: spec.customerType, qty: 1 }],
      event_id: spec.event_id,
      id: p.id,
    });
  }
  return out;
}
