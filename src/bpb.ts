import { type BpbConfig } from "./config";
import type { RideCatalog } from "./rides";
import type { Env, QueueObs, QueueSnapshot } from "./types";

/** The API sits behind Cloudflare with a WAF rule that 403s desktop-browser
 *  User-Agents — it expects the mobile app. So we must send the app's own UA (a
 *  browser-y `Mozilla/…` UA gets blocked; the app UA reaches the Laravel app).
 *  See docs/blackpool-api.md. */
const APP_UA = "PleasureBeachResort/3.2.3 (Android)";

/**
 * Blackpool Pleasure Beach queue times, from the bespoke Laravel API that backs
 * the official app (see docs/blackpool-api.md). Like Paulton's (`firstoption.ts`)
 * and Flamingo Land (`firebase.ts`) it's an independent park with inline ride
 * names, so it reuses the same normalisation into one synthetic queue line per
 * ride and synthesises its catalog from the feed. What's different here:
 *   - it's a genuine LIVE feed (each poll is current state), so a closed ride's
 *     wait is simply nulled — no last-known-state handling like Paulton's;
 *   - reads sit behind a per-USER Sanctum bearer token. There's no app-embedded
 *     static token (Paulton's) and no anonymous auth (Flamingo Land), so we log in
 *     with a dedicated account (BPB_EMAIL/BPB_PASSWORD secrets) and cache the
 *     token in R2, re-logging in on a 401. Sanctum tokens don't expire, so unlike
 *     Firebase there's no refresh dance — just login-once, reuse, relogin-on-401.
 *
 * `active`/`closed` give open/operational (open = active && !closed); the wait is
 * nulled unless running. A ride that's closed with no scheduled time today gets a
 * synthesised "Closed all day" note (surfaced via `closedNote`, like Flamingo's
 * `downAllDay`); an otherwise-closed ride reads plain "Closed" (the frontend park
 * def is marked `liveClosed`). The day's park window (sparkline x-axis) is derived
 * from the min/max of the rides' `latest_ride_time` — no extra request.
 */

const tokenKey = (park: string) => `bpb/${park}/auth.json`;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface RideRow {
  id?: number;
  rideId?: number;
  ride?: string;
  category?: string;
  queueTime?: number | null;
  active?: boolean;
  closed?: boolean;
  latest_ride_time?: {
    date?: string;
    open_time?: string; // "HH:MM:SS" (park-local)
    close_time?: string;
  } | null;
}

export interface BpbFetch {
  ok: boolean;
  httpStatus: number;
  snapshot: QueueSnapshot;
  /** Catalog synthesised from the feed's inline names (+ category as the UI
   *  group). Persisted to R2 like the other inline-name backends. */
  catalog: RideCatalog;
  /** The day's park opening window (minutes since UTC midnight), derived from the
   *  rides' `latest_ride_time`. Absent when no ride reports one today. */
  resort?: { open: number; close: number };
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

/* ── Sanctum token (login + cache in R2) ─────────────────────────────────────── */

async function readToken(bucket: R2Bucket, park: string): Promise<string | null> {
  const obj = await bucket.get(tokenKey(park));
  if (!obj) return null;
  try {
    return ((await obj.json()) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

/** Log in with the dedicated account and cache the token. Returns null on any
 *  failure (missing secrets, bad creds, network) — the caller then no-ops. */
async function login(cfg: BpbConfig, env: Env, park: string): Promise<string | null> {
  if (!env.BPB_EMAIL || !env.BPB_PASSWORD) return null;
  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}/api/app/v3/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": APP_UA,
      },
      body: JSON.stringify({ email: env.BPB_EMAIL, password: env.BPB_PASSWORD }),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const d = (await resp.json().catch(() => null)) as { token?: string } | null;
  if (!d?.token) return null;
  await env.BUCKET.put(tokenKey(park), JSON.stringify({ token: d.token }), {
    httpMetadata: { contentType: "application/json" },
  });
  return d.token;
}

/* ── Fetch + normalise ───────────────────────────────────────────────────────── */

/** London's UTC offset in minutes for a date (BST → 60, GMT → 0), so park-local
 *  opening times land on the same minutes-since-UTC-midnight axis as the samples. */
function londonOffsetMin(date: string): number {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(`${date}T12:00:00Z`)),
  );
  return (h - 12) * 60;
}

/** "HH:MM:SS" park-local → minutes since UTC midnight, or null if unparseable. */
function localTimeToUtcMin(t: string | undefined, offsetMin: number): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(t ?? "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) - offsetMin;
}

/** Request the live queue feed once with the given token. */
function getQueueTimes(cfg: BpbConfig, token: string): Promise<Response> {
  return fetch(`${cfg.apiUrl}/api/app/v3/queue-times`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": APP_UA,
    },
  });
}

export async function fetchBpbQueues(
  cfg: BpbConfig,
  env: Env,
  park: string,
  now: number,
): Promise<BpbFetch> {
  const fail = (httpStatus: number): BpbFetch => ({
    ok: false,
    httpStatus,
    snapshot: {},
    catalog: emptyCatalog(now),
    linesSeen: 0,
  });

  let token = (await readToken(env.BUCKET, park)) ?? (await login(cfg, env, park));
  if (!token) return fail(401);

  let resp: Response;
  try {
    resp = await getQueueTimes(cfg, token);
    // Cached token rejected (expired/revoked) → re-login once and retry.
    if (resp.status === 401) {
      const fresh = await login(cfg, env, park);
      if (!fresh) return fail(401);
      token = fresh;
      resp = await getQueueTimes(cfg, token);
    }
  } catch {
    return fail(0);
  }
  if (!resp.ok) return fail(resp.status);

  let rows: RideRow[];
  try {
    rows = (await resp.json()) as RideRow[];
  } catch {
    return fail(resp.status);
  }
  if (!Array.isArray(rows)) return fail(resp.status);

  const today = ymd(now);
  const offset = londonOffsetMin(today);
  const snapshot: QueueSnapshot = {};
  const catalog = emptyCatalog(now);
  let winOpen = Infinity;
  let winClose = -Infinity;

  for (const r of rows) {
    const rideId = r.rideId ?? r.id;
    if (rideId == null) continue;

    const active = r.active === true;
    const closed = r.closed === true;
    const running = active && !closed;

    // Per-ride scheduled hours today → frames the park window, and tells an
    // all-day closure (no schedule) apart from a temporary "Closed" (has one).
    const lrt = r.latest_ride_time ?? null;
    const hasScheduleToday = !!lrt && lrt.date === today;
    if (hasScheduleToday) {
      const o = localTimeToUtcMin(lrt!.open_time, offset);
      const c = localTimeToUtcMin(lrt!.close_time, offset);
      if (o != null) winOpen = Math.min(winOpen, o);
      if (c != null) winClose = Math.max(winClose, c);
    }

    const status = running ? null : closed && !hasScheduleToday ? "Closed all day" : null;
    const obs: QueueObs = {
      rideId,
      queueLineId: rideId,
      lineType: "physical_main",
      queueTime: running ? r.queueTime ?? null : null,
      status,
      isOpen: active,
      isOperational: !closed,
    };
    snapshot[`${rideId}:${rideId}`] = obs;

    const name = (r.ride ?? "").trim();
    if (name) {
      const group = (r.category ?? "").trim();
      catalog.items[String(rideId)] = { name, ...(group ? { group } : {}) };
    }
    catalog.queueLines[String(rideId)] = { item: rideId, type: "physical_main" };
  }

  const resort =
    winOpen < winClose ? { open: winOpen, close: winClose } : undefined;

  return {
    ok: true,
    httpStatus: resp.status,
    snapshot,
    catalog,
    resort,
    linesSeen: Object.keys(snapshot).length,
  };
}
