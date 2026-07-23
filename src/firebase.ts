import { USER_AGENT, type FirebaseConfig } from "./config";
import type { RideCatalog } from "./rides";
import type { QueueObs, QueueSnapshot } from "./types";

/**
 * Flamingo Land queue times, from the Firebase Cloud Firestore database that
 * backs the official app (see docs/flamingoland-api.md). Like Paulton's
 * (`src/firstoption.ts`) it's an independent park with inline ride names, so it
 * reuses the same normalisation into one synthetic queue line per ride and
 * synthesises its catalog from the feed — but the source is different:
 *   - waits come from a Firestore collection (`rides_data`), one doc per ride,
 *     read over the Firestore REST API (field-masked to skip each ride's
 *     description HTML);
 *   - `queue_time` is already in whole MINUTES (the app renders "{queue_time} min");
 *   - reads are NOT public: they require a Firebase ID token. The app enables
 *     ANONYMOUS auth, so we mint one anonymous user with the app-embedded web
 *     `apiKey` and reuse it — the {idToken, refreshToken} is cached in R2 and the
 *     hour-long idToken refreshed as needed (rather than signing up a fresh
 *     anonymous user every poll, which would litter their project with ~1440
 *     anon users/day).
 *
 * `statusOpen` is the open flag; `underMaintenance`/`downAllDay` fold into
 * is_operational. The wait is nulled unless the ride is running (open &&
 * operational), matching the Attractions.io feed and Paulton's.
 */

const FIRESTORE = "https://firestore.googleapis.com/v1";
const IDENTITY = "https://identitytoolkit.googleapis.com/v1";
const SECURETOKEN = "https://securetoken.googleapis.com/v1";

/** Doc fields we read — everything else (description HTML, images, restrictions)
 *  is dropped by the Firestore field mask so the per-minute response stays small. */
const FIELDS = [
  "id",
  "title",
  "category",
  "queue_time",
  "statusOpen",
  "underMaintenance",
  "downAllDay",
  "isRide",
] as const;

export interface FirebaseFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  /** Ride catalog synthesised from the docs' inline names (+ category as the
   *  UI group). Persisted to R2 like the Paulton's catalog. */
  catalog: RideCatalog;
  linesSeen: number;
}

function emptyCatalog(now: number): RideCatalog {
  return {
    version: "",
    generated_at: new Date(now).toISOString(),
    groupBy: "thrill",
    items: {},
    queueLines: {},
  };
}

/* ── Firestore typed values ──────────────────────────────────────────────────── */

interface FsValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
}
interface FsDoc {
  name?: string;
  fields?: Record<string, FsValue>;
}

const asInt = (v?: FsValue): number | null => {
  if (!v) return null;
  if (v.integerValue != null) {
    const n = Number(v.integerValue);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v.doubleValue === "number") return Math.round(v.doubleValue);
  return null;
};
const asBool = (v?: FsValue): boolean => v?.booleanValue === true;
const asStr = (v?: FsValue): string | null =>
  typeof v?.stringValue === "string" ? v.stringValue : null;

/** Decode the HTML entities Firestore stores in ride titles (e.g. the app shows
 *  "Children&#8217;s Planet"). Numeric first, then the handful of named ones. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/* ── Anonymous Firebase auth (cached + refreshed in R2) ──────────────────────── */

const tokenKey = (park: string) => `firebase/${park}/auth.json`;

interface TokenCache {
  idToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

async function readTokenCache(bucket: R2Bucket, park: string): Promise<TokenCache | null> {
  const obj = await bucket.get(tokenKey(park));
  if (!obj) return null;
  try {
    const c = (await obj.json()) as Partial<TokenCache>;
    if (!c.idToken || !c.refreshToken || typeof c.expiresAt !== "number") return null;
    return c as TokenCache;
  } catch {
    return null;
  }
}

async function writeTokenCache(
  bucket: R2Bucket,
  park: string,
  tc: TokenCache,
): Promise<void> {
  await bucket.put(tokenKey(park), JSON.stringify(tc), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Create a brand-new anonymous user. Used once (no cache) or when a refresh
 *  fails (revoked/expired refresh token). */
async function signUpAnon(apiKey: string, now: number): Promise<TokenCache | null> {
  let resp: Response;
  try {
    resp = await fetch(`${IDENTITY}/accounts:signUp?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ returnSecureToken: true }),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const d = (await resp.json().catch(() => null)) as {
    idToken?: string;
    refreshToken?: string;
    expiresIn?: string;
  } | null;
  if (!d?.idToken || !d.refreshToken) return null;
  return {
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    expiresAt: now + Number(d.expiresIn ?? "3600") * 1000,
  };
}

/** Trade the cached refresh token for a fresh idToken (idTokens last ~1h). */
async function refreshAnon(
  apiKey: string,
  refreshToken: string,
  now: number,
): Promise<TokenCache | null> {
  let resp: Response;
  try {
    resp = await fetch(`${SECURETOKEN}/token?key=${apiKey}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const d = (await resp.json().catch(() => null)) as {
    id_token?: string;
    refresh_token?: string;
    expires_in?: string;
  } | null;
  if (!d?.id_token || !d.refresh_token) return null;
  return {
    idToken: d.id_token,
    refreshToken: d.refresh_token,
    expiresAt: now + Number(d.expires_in ?? "3600") * 1000,
  };
}

/** A usable anonymous idToken: the cached one while still valid, else a refresh,
 *  else a fresh anonymous sign-up. Persists whatever it obtains. Returns null
 *  only if every path fails (and there's no stale token to fall back on). */
async function getIdToken(
  cfg: FirebaseConfig,
  bucket: R2Bucket,
  park: string,
  now: number,
): Promise<string | null> {
  const cached = await readTokenCache(bucket, park);
  if (cached && cached.expiresAt > now + 60_000) return cached.idToken;

  let tc: TokenCache | null = null;
  if (cached?.refreshToken) tc = await refreshAnon(cfg.apiKey, cached.refreshToken, now);
  if (!tc) tc = await signUpAnon(cfg.apiKey, now);
  if (!tc) return cached?.idToken ?? null; // last resort: a stale token may still work

  await writeTokenCache(bucket, park, tc);
  return tc.idToken;
}

/* ── Fetch + normalise ───────────────────────────────────────────────────────── */

/** List every doc in the collection, field-masked, following pagination.
 *  Firestore's default page size is small (20), so we set it high and still
 *  drain any `nextPageToken` for correctness. */
async function listDocs(
  cfg: FirebaseConfig,
  token: string,
): Promise<{ docs: FsDoc[]; status: number }> {
  const docs: FsDoc[] = [];
  let pageToken: string | undefined;
  let status = 0;
  for (let page = 0; page < 10; page++) {
    const url = new URL(
      `${FIRESTORE}/projects/${cfg.projectId}/databases/(default)/documents/${cfg.collection}`,
    );
    url.searchParams.set("pageSize", "300");
    for (const f of FIELDS) url.searchParams.append("mask.fieldPaths", f);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
    });
    status = resp.status;
    if (!resp.ok) return { docs, status };
    const data = (await resp.json()) as { documents?: FsDoc[]; nextPageToken?: string };
    if (data.documents) docs.push(...data.documents);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return { docs, status: status || 200 };
}

export async function fetchFirebaseQueues(
  cfg: FirebaseConfig,
  bucket: R2Bucket,
  park: string,
  now: number,
): Promise<FirebaseFetch> {
  const fail = (httpStatus: number): FirebaseFetch => ({
    ok: false,
    httpStatus,
    snapshot: {},
    catalog: emptyCatalog(now),
    linesSeen: 0,
  });

  const token = await getIdToken(cfg, bucket, park, now);
  if (!token) return fail(401);

  let docs: FsDoc[];
  let status: number;
  try {
    ({ docs, status } = await listDocs(cfg, token));
  } catch {
    return fail(0);
  }
  if (status < 200 || status >= 300) return fail(status);

  const snapshot: QueueSnapshot = {};
  const catalog = emptyCatalog(now);
  for (const doc of docs) {
    const f = doc.fields ?? {};
    if (f.isRide?.booleanValue === false) continue; // non-ride POI
    const rideId = asInt(f.id);
    if (rideId == null) continue;

    // `underMaintenance`/`downAllDay` make a ride non-operational; `statusOpen`
    // is the open flag. Wait is only meaningful while running, so null it
    // otherwise — matching Paulton's and the Attractions.io feed (`queue_time`
    // lingers with a stale value when closed). One synthetic "main" line per
    // ride, keyed by the ride id (globally unique).
    const maint = asBool(f.underMaintenance);
    const down = asBool(f.downAllDay);
    const isOpen = asBool(f.statusOpen);
    const isOperational = !maint && !down;
    const running = isOpen && isOperational;
    // The feed reports authoritative current state, so a closed ride carries a
    // reason: `downAllDay` → "Closed all day" (the park's own all-day-closure
    // signal), `underMaintenance` → "Under maintenance". Surfaced downstream via
    // `closedNote` (db.ts). A merely-closed ride (neither flag) has no note and
    // reads as plain "Closed" — the frontend only ever shows "Closed all day"
    // from an explicit note, never inferred.
    const status = isOpen
      ? null
      : down
        ? "Closed all day"
        : maint
          ? "Under maintenance"
          : null;
    const obs: QueueObs = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running ? asInt(f.queue_time) : null,
      status,
      isOpen,
      isOperational,
    };
    snapshot[`${rideId}:${rideId}`] = obs;

    const name = decodeEntities(asStr(f.title) ?? "").trim();
    if (name) {
      const group = decodeEntities(asStr(f.category) ?? "").trim();
      catalog.items[String(rideId)] = { name, ...(group ? { group } : {}) };
    }
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };
  }

  return {
    ok: true,
    httpStatus: status,
    snapshot,
    catalog,
    linesSeen: Object.keys(snapshot).length,
  };
}
