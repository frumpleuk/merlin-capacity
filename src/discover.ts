import {
  bootstrapUrl,
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

/** Bumped whenever `fetchCatalogPackages`'s FILTER changes (not the catalog).
 *  The refresh is a conditional GET on the catalog ETag, so without this a cache
 *  written by the old filter would survive untouched until accesso next edited
 *  its catalog. A mismatch forces one unconditional rebuild.
 *  2: day-ticket `name` matched exactly, dropping the discount variants that
 *     report their own ring-fenced sub-allocation (see fetchCatalogPackages). */
const FILTER_VERSION = 2;

interface CachedList {
  generated_at: string;
  P: unknown[];
  /** Package ids in `P` that are yield anchors (prebooks), not the public day
   *  ticket — used to flag prebook-only dates. */
  anchorIds: string[];
  /** The bootstrap catalog's ETag when this list was derived, for the next
   *  refresh's conditional GET (skip the 2.83MB re-parse when unchanged). */
  etag?: string | null;
  /** The FILTER_VERSION that derived this list. Older/absent → refetch. */
  filter_version?: number;
}

/** A resolved package list plus which of its ids are yield anchors. */
export interface ResolvedPackages {
  P: unknown[];
  anchorIds: string[];
}

const cacheKey = (park: string, product: string) => `catalog/${park}/${product}.json`;

/**
 * The package selectors to send to GetMerchantPackageEventDates for a product:
 * a hardcoded `P` (RAP — not in the catalog), or the list rediscovered from the
 * park's bootstrap catalog. HOT PATH — reads the R2 cache ONLY, never the 2.83MB
 * bootstrap (no point fetching + parsing it every poll when its ids rotate only
 * seasonally). The cache is kept current by the pre-open daily `refreshPackages`.
 * An empty list (no cache yet) makes the poll log NO_PACKAGES and skip.
 */
export async function resolvePackages(
  bucket: R2Bucket,
  park: ParkConfig,
  product: ProductConfig,
): Promise<ResolvedPackages> {
  if (product.P) return { P: product.P, anchorIds: [] };
  if (!product.discover) return { P: [], anchorIds: [] };
  const cached = await readCache(bucket, cacheKey(park.key, product.key));
  return cached ? { P: cached.P, anchorIds: cached.anchorIds } : { P: [], anchorIds: [] };
}

/**
 * Refresh a discover-product's cached package list from the bootstrap catalog.
 * Runs OFF the hot path — the pre-open daily cron and `/poll` — because it may
 * parse the 2.83MB catalog. A conditional GET means an unchanged catalog (almost
 * every day; ids rotate only seasonally) answers 304 and we skip the download +
 * parse entirely. Never throws; on any failure keeps the last good cached list.
 */
export async function refreshPackages(
  bucket: R2Bucket,
  park: ParkConfig,
  product: ProductConfig,
  now: number,
): Promise<void> {
  if (!product.discover) return; // RAP (static P) has nothing to discover
  const key = cacheKey(park.key, product.key);
  const cached = await readCache(bucket, key);
  // Only reuse the ETag if the cached list came from the CURRENT filter —
  // otherwise a filter change would sit behind 304s forever (see FILTER_VERSION).
  const etagToSend =
    cached?.filter_version === FILTER_VERSION ? cached.etag : null;
  const fresh = await fetchCatalogPackages(park, product.discover, etagToSend);
  if (fresh.notModified) return; // 304 — cached list still current
  if (fresh.P.length === 0) return; // catalog down / mid-rotation — keep old list
  const body: CachedList = {
    generated_at: new Date(now).toISOString(),
    P: fresh.P,
    anchorIds: fresh.anchorIds,
    etag: fresh.etag,
    filter_version: FILTER_VERSION,
  };
  await bucket.put(key, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function readCache(bucket: R2Bucket, key: string): Promise<CachedList | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    const d = (await obj.json()) as Partial<CachedList>;
    if (!Array.isArray(d.P) || !d.generated_at) return null;
    return {
      generated_at: d.generated_at,
      P: d.P,
      anchorIds: d.anchorIds ?? [],
      etag: d.etag ?? null,
      filter_version: d.filter_version,
    };
  } catch {
    return null;
  }
}

/** fetchCatalogPackages result: the derived list + the catalog ETag, or a 304
 *  `notModified` signal telling the caller to keep its cached list. */
interface CatalogFetch extends ResolvedPackages {
  etag?: string | null;
  notModified?: boolean;
}

/** Fetch the bootstrap catalog and build the P[] for the matching packages, plus
 *  the subset of ids that are yield anchors (prebooks). Conditional on `prevEtag`
 *  — a 304 returns `notModified` and skips the parse. */
async function fetchCatalogPackages(
  park: ParkConfig,
  spec: DiscoverSpec,
  prevEtag?: string | null,
): Promise<CatalogFetch> {
  const empty: CatalogFetch = { P: [], anchorIds: [] };
  let resp: Response;
  try {
    resp = await fetch(bootstrapUrl(park.bootstrapSlug ?? ""), {
      headers: {
        accept: "application/json, text/plain, */*",
        // See merlin.ts: `?? ""` is type-only; only reached for ticket parks.
        origin: park.origin ?? "",
        referer: `${park.origin ?? ""}/`,
        "user-agent": USER_AGENT,
        ...(prevEtag ? { "if-none-match": prevEtag } : {}),
      },
    });
  } catch {
    return empty;
  }
  if (resp.status === 304) return { P: [], anchorIds: [], notModified: true };
  if (!resp.ok) return empty;
  const etag = resp.headers.get("etag");

  let data: Bootstrap;
  try {
    data = (await resp.json()) as Bootstrap;
  } catch {
    return empty;
  }
  const packages = data.GetMerchantPackageList?.SERVICE?.PS?.P;
  if (!Array.isArray(packages)) return empty;

  const wantClass = spec.packageClass ?? "Daily Tickets";
  const wantName = (spec.name ?? "1 Day Ticket").trim().toLowerCase();
  const anchorMatch = (spec.anchorClassMatch ?? "prebook").toLowerCase();
  const P: unknown[] = [];
  const anchorIds: string[] = [];
  const seen = new Set<string>();
  for (const p of packages) {
    if (!asArray(p.E).some((e) => e.id === spec.event_id)) continue;

    const cls = p.package_class ?? "";
    // The public day ticket. EXACT name, not a substring: the discount variants
    // ("1 Day Ticket - 10% Offer", "Student 1 Day Ticket") book against a small
    // ring-fenced sub-allocation of the same event, and one of those in P[] makes
    // the API report THAT bucket for the date instead of the park pool — see
    // docs/accesso-api.md §3.1 "Multiple allocations per date".
    const isDayTicket =
      cls === wantClass && (p.name ?? "").trim().toLowerCase() === wantName;
    // The yield anchor — annual-pass prebooks (see DiscoverSpec.anchorClassMatch).
    const isAnchor = anchorMatch !== "" && cls.toLowerCase().includes(anchorMatch);
    // A day ticket takes precedence: if a package is both, it's a public sale.
    if (!isDayTicket && !isAnchor) continue;

    // Send each package with its OWN customer type. Forcing a single CT narrows
    // the returned dates (some packages only sell under other CTs), so days would
    // go missing — the per-date capacity is the same regardless.
    const ct = asArray(p.CT)
      .map((c) => c.id)
      .find((id): id is string => !!id);
    if (!ct || seen.has(p.id)) continue;
    seen.add(p.id);
    P.push({ CT: [{ id: ct, qty: 1 }], event_id: spec.event_id, id: p.id });
    if (isAnchor && !isDayTicket) anchorIds.push(p.id);
  }
  return { P, anchorIds, etag };
}
