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

interface CachedList {
  generated_at: string;
  P: unknown[];
  /** Package ids in `P` that are yield anchors (prebooks), not the public day
   *  ticket — used to flag prebook-only dates. */
  anchorIds: string[];
  /** The bootstrap catalog's ETag when this list was derived, for the next
   *  refresh's conditional GET (skip the 2.83MB re-parse when unchanged). */
  etag?: string | null;
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
 * bootstrap: that ~18ms JSON.parse would blow the 10ms budget mid-poll. The cache
 * is kept current by the pre-open daily `refreshPackages`. An empty list (no
 * cache yet) makes the poll log NO_PACKAGES and skip, same as before.
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
  const fresh = await fetchCatalogPackages(park, product.discover, cached?.etag);
  if (fresh.notModified) return; // 304 — cached list still current
  if (fresh.P.length === 0) return; // catalog down / mid-rotation — keep old list
  const body: CachedList = {
    generated_at: new Date(now).toISOString(),
    P: fresh.P,
    anchorIds: fresh.anchorIds,
    etag: fresh.etag,
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

/** i points at an opening `"`; returns the index just past the closing `"`,
 *  honouring backslash escapes. */
function skipString(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") i++;
    else if (ch === '"') return i + 1;
  }
  throw new Error("unterminated string");
}

/** Skip one JSON value whose first char is at `i` (no leading whitespace) and
 *  return the index just past it. String-aware, so nested `{ } [ ] "` and
 *  escapes inside strings can't throw the bracket depth off. */
function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        i = skipString(s, i) - 1; // -1: the loop's i++ re-lands past the string
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
    }
    throw new Error("unterminated container");
  }
  // number / true / false / null — run to the next structural delimiter.
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === "," || ch === "}" || ch === "]") return i;
  }
  throw new Error("unterminated primitive");
}

const isWs = (ch: string) =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i++;
  return i;
}

/**
 * Partial extractor for the 2.83MB bootstrap: pull the package list out of the
 * catalog TEXT, materialising only the five fields the classifier reads per
 * package (`id`/`name`/`package_class`/`E`/`CT`) and never constructing the
 * top-level `GetApplicationConsolidated` (1.5MB / 54%, unused) or the ~27 unused
 * package fields (`desc`, `shop_image_v4`, `CHARACS`, …). A hand-written char
 * scanner over accesso's fixed structure — measured ~15-20% cheaper than a full
 * `JSON.parse`, though this runs at most once/day per park (a conditional GET
 * 304s the unchanged catalog) and off the hot path. Returns the package array,
 * or `null` on ANY structural surprise so the caller falls back to a full parse.
 * `E`/`CT` keep accesso's object-or-array shape verbatim (their raw slice is
 * JSON.parsed as-is).
 */
export function extractCatalogPackages(text: string): CatalogPackage[] | null {
  try {
    // Anchor on the unique `"PS"` inside GetMerchantPackageList; its `"P":[` is
    // the package array. GetApplicationConsolidated sits earlier in the bytes and
    // is never scanned into (indexOf jumps straight past it).
    const gi = text.indexOf('"GetMerchantPackageList"');
    if (gi < 0) return null;
    const psi = text.indexOf('"PS"', gi);
    if (psi < 0) return null;
    const pk = text.indexOf('"P"', psi);
    if (pk < 0) return null;
    let i = text.indexOf("[", pk);
    if (i < 0) return null;

    const packages: CatalogPackage[] = [];
    i = skipWs(text, i + 1); // past '['
    if (text[i] === "]") return packages; // empty array

    for (;;) {
      i = skipWs(text, i);
      if (text[i] !== "{") return null;
      i++; // past '{'
      const pkg = {} as CatalogPackage;
      for (;;) {
        i = skipWs(text, i);
        if (text[i] === "}") {
          i++;
          break;
        }
        if (text[i] !== '"') return null;
        const keyEnd = skipString(text, i);
        const key = text.slice(i, keyEnd); // quoted, e.g. `"id"`
        i = skipWs(text, keyEnd);
        if (text[i] !== ":") return null;
        i = skipWs(text, i + 1);
        const valStart = i;
        i = skipValue(text, i);
        // Materialise only the five fields the classifier below reads.
        switch (key) {
          case '"id"':
            pkg.id = JSON.parse(text.slice(valStart, i));
            break;
          case '"name"':
            pkg.name = JSON.parse(text.slice(valStart, i));
            break;
          case '"package_class"':
            pkg.package_class = JSON.parse(text.slice(valStart, i));
            break;
          case '"E"':
            pkg.E = JSON.parse(text.slice(valStart, i));
            break;
          case '"CT"':
            pkg.CT = JSON.parse(text.slice(valStart, i));
            break;
        }
        i = skipWs(text, i);
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          break;
        }
        return null;
      }
      packages.push(pkg);
      i = skipWs(text, i);
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") return packages;
      return null;
    }
  } catch {
    return null;
  }
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

  // Read the body as text and pull just the package list out of it (skipping the
  // 1.5MB unused GetApplicationConsolidated + the unused package fields — a
  // ~15-20% parse-CPU saving; off the hot path). On ANY extractor surprise, fall
  // back to a full JSON.parse so behaviour is exactly as before.
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return empty;
  }
  let packages = extractCatalogPackages(text);
  if (packages === null) {
    try {
      const data = JSON.parse(text) as Bootstrap;
      packages = data.GetMerchantPackageList?.SERVICE?.PS?.P ?? null;
    } catch {
      return empty;
    }
  }
  if (!Array.isArray(packages)) return empty;

  const wantClass = spec.packageClass ?? "Daily Tickets";
  const wantName = (spec.name ?? "1 Day Ticket").toLowerCase();
  const anchorMatch = (spec.anchorClassMatch ?? "prebook").toLowerCase();
  const P: unknown[] = [];
  const anchorIds: string[] = [];
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
    // A day ticket takes precedence: if a package is both, it's a public sale.
    if (!isDayTicket && !isAnchor) continue;

    // Send each package with its OWN customer type. Forcing a single CT narrows
    // the returned dates (some variants only sell under other CTs), so days would
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
