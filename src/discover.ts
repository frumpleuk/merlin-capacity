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
  const wantName = (spec.name ?? "1 Day Ticket").toLowerCase();
  const anchorMatch = (spec.anchorClassMatch ?? "prebook").toLowerCase();
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const p of packages) {
    if (!asArray(p.E).some((e) => e.id === spec.event_id)) continue;

    const cls = p.package_class ?? "";
    // The public day ticket. Substring, not exact, on the name: seasonal/offer
    // variants ("1 Day Ticket - 10% Offer") are what cover the on-sale autumn
    // dates.
    const isDayTicket =
      cls === wantClass && (p.name ?? "").toLowerCase().includes(wantName);
    // The yield anchor — annual-pass prebooks (see DiscoverSpec.anchorClassMatch).
    const isAnchor = anchorMatch !== "" && cls.toLowerCase().includes(anchorMatch);
    if (!isDayTicket && !isAnchor) continue;

    // Send each package with its OWN customer type. Forcing a single CT narrows
    // the returned dates (some variants only sell under other CTs), so days would
    // go missing — the per-date capacity is the same regardless.
    const ct = asArray(p.CT)
      .map((c) => c.id)
      .find((id): id is string => !!id);
    if (!ct || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ CT: [{ id: ct, qty: 1 }], event_id: spec.event_id, id: p.id });
  }
  return out;
}
