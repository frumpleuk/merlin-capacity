import { Unzip, UnzipInflate } from "fflate";
import {
  ATTRACTIONS_API,
  CATALOG_TTL_MS,
  USER_AGENT,
  type AttractionsConfig,
} from "./config";

/** One ride's static metadata (from the content bundle's `Item` records). */
export interface RideMeta {
  name: string;
  category?: number;
  minHeight?: number | null; // metres
  /** The park's own grouping for this ride: its thrill class (e.g. "Thrills",
   *  "Top Thrills", "Brave Adventurers") from the `WaitTimeClassifications`
   *  collection, or — for a park that leaves that empty (Legoland) — its themed
   *  land (e.g. "LEGO® City", "Kingdom of the Pharaohs"). See `buildCatalog`. */
  group?: string;
}

/** The static join tables we keep from a park's content bundle: ride names and
 *  the queue-line → ride mapping. `media/*` and every other entity is dropped. */
export interface RideCatalog {
  version: string; // manifest.json version cursor (ISO8601)
  generated_at: string;
  /** How this park's `group`s are derived: by thrill class (most parks) or by
   *  themed land (Legoland — see `buildCatalog`). Drives section tone/order in
   *  the UI, since land sections aren't a thrill ranking. */
  groupBy: "thrill" | "land";
  items: Record<string, RideMeta>; // Item._id → meta (rides only)
  queueLines: Record<string, { item: number; type: string }>; // QueueLine._id → {ride, type}
}

const authHeader = (apiKey: string, token?: string) =>
  token
    ? `Attractions-Io api-key="${apiKey}", installation-token="${token}"`
    : `Attractions-Io api-key="${apiKey}"`;

const catalogKey = (park: string) => `queues/${park}/catalog.json`;
const tokenKey = (park: string) => `attractions/${park}/token.json`;

/**
 * The static ride catalog for a park: cached in R2 on a TTL and re-derived from
 * the Attractions.io content bundle when stale. Never throws — on any failure
 * (registration, bundle fetch, unzip) it falls back to the last cached catalog,
 * mirroring the resilience of `discoverPackages` in discover.ts.
 */
export async function resolveRideCatalog(
  bucket: R2Bucket,
  park: string,
  cfg: AttractionsConfig,
  now: number,
): Promise<RideCatalog | null> {
  const cached = await readCachedCatalog(bucket, park);
  if (cached && now - Date.parse(cached.generated_at) < CATALOG_TTL_MS) {
    return cached;
  }

  try {
    const fresh = await buildCatalog(bucket, park, cfg, now);
    await bucket.put(catalogKey(park), JSON.stringify(fresh), {
      httpMetadata: { contentType: "application/json" },
    });
    return fresh;
  } catch {
    // Bundle down, token dead, or unzip failed — keep serving the last good
    // catalog rather than losing ride names entirely.
    return cached;
  }
}

async function readCachedCatalog(
  bucket: R2Bucket,
  park: string,
): Promise<RideCatalog | null> {
  const obj = await bucket.get(catalogKey(park));
  if (!obj) return null;
  try {
    const c = (await obj.json()) as Partial<RideCatalog>;
    if (!c.items || !c.queueLines || !c.generated_at) return null;
    return c as RideCatalog;
  } catch {
    return null;
  }
}

/** Fetch the current content bundle and project it down to the join tables. */
async function buildCatalog(
  bucket: R2Bucket,
  park: string,
  cfg: AttractionsConfig,
  now: number,
): Promise<RideCatalog> {
  const { manifest, records, collections } = await fetchBundle(bucket, park, cfg);

  const items = (records.Item as ApiItem[] | undefined) ?? [];
  const queueLines = (records.QueueLine as ApiQueueLine[] | undefined) ?? [];

  const qlOut: RideCatalog["queueLines"] = {};
  const rideIds = new Set<number>();
  for (const q of queueLines) {
    if (q._id == null || q.Item == null) continue;
    qlOut[String(q._id)] = { item: q.Item, type: q.Type ?? "physical_main" };
    rideIds.add(q.Item);
  }

  // The park's own grouping for a ride. Most parks group by thrill level — the
  // classifications in the `WaitTimeClassifications` collection (e.g. Thrills /
  // Family Fun / Navigate & Relax). Legoland leaves that collection empty and
  // groups by themed land instead (Kingdom of the Pharaohs, LEGO® City, NINJAGO®
  // World, …), carried as an `Item.Classifications` tag rather than in a
  // collection. Those land classifications are exactly the ones whose name
  // matches an `Area` record (the map's themed lands), which cleanly excludes
  // the other same-list classifications (dietary tags, hotels). So: prefer the
  // thrill grouping, and fall back to themed lands when a park has none.
  const classifications =
    (records.Classification as ApiClassification[] | undefined) ?? [];
  const classNames = new Map(classifications.map((c) => [c._id, c.Name]));
  const wtc = collections.find((c) => c.name === "WaitTimeClassifications")?.members;
  const norm = (s: string) => s.replace(/[®™’']/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const areaNames = new Set(
    (records.Area as ApiArea[] | undefined)?.map((a) => norm(a.Name)) ?? [],
  );
  const groupBy: RideCatalog["groupBy"] = wtc?.length ? "thrill" : "land";
  const groupMembers = new Set(
    groupBy === "thrill"
      ? wtc
      : classifications.filter((c) => areaNames.has(norm(c.Name))).map((c) => c._id),
  );
  const groupOf = (it: ApiItem): string | undefined => {
    for (const cid of it.Classifications ?? []) {
      if (groupMembers.has(cid)) return classNames.get(cid);
    }
    return undefined;
  };

  // Keep only the Items that are actually rides (referenced by a queue line).
  const byId = new Map(items.map((i) => [i._id, i]));
  const itemsOut: RideCatalog["items"] = {};
  for (const id of rideIds) {
    const it = byId.get(id);
    if (!it?.Name) continue; // a few QueueLine.Item refs point at absent items
    const group = groupOf(it);
    itemsOut[String(id)] = {
      name: it.Name,
      ...(it.Category != null ? { category: it.Category } : {}),
      ...(it.MinimumHeightRequirement != null
        ? { minHeight: it.MinimumHeightRequirement }
        : {}),
      ...(group ? { group } : {}),
    };
  }

  return {
    version: manifest.version ?? "",
    generated_at: new Date(now).toISOString(),
    groupBy,
    items: itemsOut,
    queueLines: qlOut,
  };
}

interface ApiItem {
  _id: number;
  Name?: string;
  Category?: number;
  Classifications?: number[];
  MinimumHeightRequirement?: number | null;
}
interface ApiQueueLine {
  _id: number;
  Item: number;
  Type?: string;
}
interface ApiClassification {
  _id: number;
  Name: string;
}
interface ApiArea {
  _id: number;
  Name: string;
}
interface ApiCollection {
  name: string;
  members?: number[];
}

/**
 * Resolve and download the current bundle, streaming-unzipping ONLY
 * `records.json` + `manifest.json` — `media/*` (the bulk of the zip) is never
 * buffered or inflated. Registers/refreshes the installation token as needed.
 */
async function fetchBundle(
  bucket: R2Bucket,
  park: string,
  cfg: AttractionsConfig,
): Promise<{
  manifest: { version?: string };
  records: Record<string, unknown[]>;
  collections: ApiCollection[];
}> {
  let token = await readToken(bucket, park);
  let dataResp = token ? await getData(cfg.apiKey, token) : undefined;

  // No token, or the cached one is dead (401) → (re)register and retry once.
  if (!dataResp || dataResp.status === 401) {
    token = await register(cfg.apiKey);
    await bucket.put(tokenKey(park), JSON.stringify({ token }), {
      httpMetadata: { contentType: "application/json" },
    });
    dataResp = await getData(cfg.apiKey, token);
  }

  // /v1/data answers 303 → the public S3 bundle. We follow it MANUALLY: workerd
  // forwards the `Authorization` header across an auto-followed cross-origin
  // redirect, and S3 rejects the Attractions-Io auth header (400). Fetch the
  // bundle with a clean, unauthenticated request instead (the bucket is public).
  const location = dataResp.headers.get("location");
  if (dataResp.status !== 303 && dataResp.status !== 302 && dataResp.status !== 301) {
    const body = await dataResp.clone().text().catch(() => "");
    throw new Error(`/v1/data unexpected ${dataResp.status} ${body.slice(0, 120)}`);
  }
  if (!location) throw new Error("/v1/data redirect had no Location");

  const bundle = await fetch(location, { headers: { "user-agent": USER_AGENT } });
  if (!bundle.ok || !bundle.body) throw new Error(`bundle fetch failed: ${bundle.status}`);

  const files = await streamUnzip(
    bundle.body,
    new Set(["records.json", "manifest.json", "collections.json"]),
  );
  const manifest = files["manifest.json"]
    ? (JSON.parse(files["manifest.json"]) as { version?: string })
    : {};
  const records = files["records.json"]
    ? (JSON.parse(files["records.json"]) as Record<string, unknown[]>)
    : {};
  const collections = files["collections.json"]
    ? (JSON.parse(files["collections.json"]) as ApiCollection[])
    : [];
  return { manifest, records, collections };
}

async function register(apiKey: string): Promise<string> {
  const resp = await fetch(`${ATTRACTIONS_API}/v1/installation`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Idempotency-Key": crypto.randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      device_identifier: "123",
      user_identifier: crypto.randomUUID(),
      app_build: "100",
      app_version: "1.0",
    }),
  });
  if (!resp.ok) throw new Error(`register failed: ${resp.status}`);
  const { token } = (await resp.json()) as { token?: string };
  if (!token) throw new Error("register returned no token");
  return token;
}

/** GET /v1/data → 303 with a `Location` pointing at the public S3 bundle. We
 *  read the redirect ourselves (`redirect: "manual"`) so the Authorization
 *  header is never forwarded to S3 — see fetchBundle. */
function getData(apiKey: string, token: string): Promise<Response> {
  return fetch(`${ATTRACTIONS_API}/v1/data`, {
    redirect: "manual",
    headers: {
      Authorization: authHeader(apiKey, token),
      Date: new Date().toUTCString(),
      "user-agent": USER_AGENT,
    },
  });
}

async function readToken(bucket: R2Bucket, park: string): Promise<string | undefined> {
  const obj = await bucket.get(tokenKey(park));
  if (!obj) return undefined;
  try {
    return ((await obj.json()) as { token?: string }).token;
  } catch {
    return undefined;
  }
}

/**
 * Stream a zip through fflate, inflating only the named members and returning
 * them as decoded strings. Every other member is skipped (no inflate handler
 * registered for it), so we never hold the whole archive or its media in memory.
 */
function streamUnzip(
  body: ReadableStream<Uint8Array>,
  wanted: Set<string>,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const parts: Record<string, Uint8Array[]> = {};
    let pending = 0;
    let ended = false;
    const done = () => {
      if (!ended || pending > 0) return;
      const out: Record<string, string> = {};
      const dec = new TextDecoder();
      for (const [name, chunks] of Object.entries(parts)) {
        let len = 0;
        for (const c of chunks) len += c.length;
        const buf = new Uint8Array(len);
        let o = 0;
        for (const c of chunks) {
          buf.set(c, o);
          o += c.length;
        }
        out[name] = dec.decode(buf);
      }
      resolve(out);
    };

    const unz = new Unzip();
    unz.register(UnzipInflate);
    unz.onfile = (file) => {
      if (!wanted.has(file.name)) return; // skip — never inflated
      const chunks: Uint8Array[] = (parts[file.name] = []);
      pending++;
      file.ondata = (err, chunk, final) => {
        if (err) return reject(err);
        if (chunk.length) chunks.push(chunk);
        if (final) {
          pending--;
          done();
        }
      };
      file.start();
    };

    const reader = body.getReader();
    const pump = async () => {
      for (;;) {
        const { done: rdone, value } = await reader.read();
        if (rdone) {
          unz.push(new Uint8Array(0), true);
          ended = true;
          done();
          return;
        }
        unz.push(value, false);
      }
    };
    pump().catch(reject);
  });
}
