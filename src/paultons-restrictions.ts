import { USER_AGENT, type FirstOptionConfig } from "./config";
import type { RideMeta } from "./rides";

/**
 * Paulton's rider restrictions — minimum height and age, both accompanied and
 * unaccompanied. Unlike the Merlin parks (Attractions.io bundle), Blackpool
 * (`restrictions` JSON in the feed) and Flamingo (Firestore `restrictions`
 * field), Paulton's First Option queue feed carries NO restriction data at all.
 * They live only on the public website's per-ride **accessibility pages**
 * (`paultonspark.co.uk/accessibility/rides/<slug>`), one page per ride, as prose
 * — e.g. EDGE: "must be at least 1.2m tall and at least 6 years old to ride …
 * at least 1.4m tall and at least 8 years old to ride without a supervising
 * adult." No structured JSON, so we parse the prose.
 *
 * That's ~38 page fetches, so it's done OFF the hot path: a daily pre-open scrape
 * (`refreshPaultonsRestrictions`) writes a `rideId → Restriction` map to R2, and
 * the every-minute queue poll only READS the cached map (`readPaultonsRestrictions`)
 * and folds it onto the synthesised catalog. Like the ride catalog, a failed
 * scrape keeps the last-good map rather than wiping restrictions.
 */

const SITE = "https://paultonspark.co.uk";
const restrictionsKey = (park: string) => `queues/${park}/restrictions.json`;

/** One ride's restrictions. Heights in metres, ages in years. Any field absent =
 *  not stated for that ride. */
export interface Restriction {
  minHeight?: number;
  minHeightUnaccompanied?: number;
  minAge?: number;
  minAgeUnaccompanied?: number;
}

/** rideId → Restriction, as cached in R2. */
export type RestrictionMap = Record<number, Restriction>;

// ── Prose parsing ──────────────────────────────────────────────────────────

const stripTags = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const HEIGHT = /at least\s*(\d(?:\.\d+)?)\s*m\s*tall/gi;
const AGE = /at least\s*(\d+)\s*years?\s*old/gi;
// A sentence describing the UNACCOMPANIED (ride-alone) threshold rather than the
// with-an-adult one.
const UNACCOMPANIED = /without a supervis|without an adult|to ride alone|unsupervis/i;

/**
 * Parse one accessibility ride page's HTML into a Restriction. Pure — no I/O.
 * Reads each sentence: values in a "without a supervising adult" sentence are the
 * unaccompanied threshold; otherwise the general (accompanied) one. When ONE
 * unaccompanied sentence carries both thresholds ("at least 1.2m … or 1.4m
 * without a supervising adult"), the lower is the accompanied minimum and the
 * higher the ride-alone minimum (you must be taller to ride alone), rather than
 * mis-tagging the first number as unaccompanied.
 */
export function parseRestrictionPage(html: string): Restriction {
  const text = stripTags(html);
  const out: Restriction = {};
  for (const sentence of text.split(/(?<=[.!])\s+/)) {
    const low = sentence.toLowerCase();
    if (!low.includes("tall") && !low.includes("years old") && !low.includes("height")) {
      continue;
    }
    const unacc = UNACCOMPANIED.test(sentence);
    const heights = [...sentence.matchAll(HEIGHT)].map((m) => Number(m[1]));
    const ages = [...sentence.matchAll(AGE)].map((m) => Number(m[1]));
    if (unacc && heights.length >= 2) {
      out.minHeight = Math.min(...heights);
      out.minHeightUnaccompanied = Math.max(...heights);
    } else if (heights.length > 0) {
      if (unacc) out.minHeightUnaccompanied = heights[0];
      else out.minHeight = heights[0];
    }
    if (unacc && ages.length >= 2) {
      out.minAge = Math.min(...ages);
      out.minAgeUnaccompanied = Math.max(...ages);
    } else if (ages.length > 0) {
      if (unacc) out.minAgeUnaccompanied = ages[0];
      else out.minAge = ages[0];
    }
  }
  return out;
}

// ── Name ↔ rideId matching ─────────────────────────────────────────────────

/** Normalise a ride name or URL slug to a comparable token string: lowercase,
 *  drop apostrophes/punctuation, drop a leading "the" and a trailing "ride". */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the\s+/, "")
    .replace(/\s+ride$/, "")
    .trim();
}

/** The exact ride id for a slug's normalised name, if any (and not already taken). */
function exactRideId(slug: string, byName: Map<string, number>, used: Set<number>): number | null {
  const id = byName.get(normalise(slug.replace(/-/g, " ")));
  return id != null && !used.has(id) ? id : null;
}

/** Fuzzy-match a slug to the still-unused ride id whose name it best describes,
 *  by token overlap (Jaccard) above a threshold — catches "prof-blasts…" ↔
 *  "Professor Blast's…" and "windy-castle-ride" ↔ "Windy Castle". Skips ids
 *  already claimed (so a page can't steal another ride's id) and returns null
 *  when nothing is close enough. */
function fuzzyRideId(slug: string, byName: Map<string, number>, used: Set<number>): number | null {
  const keyTokens = new Set(normalise(slug.replace(/-/g, " ")).split(" ").filter(Boolean));
  let best: number | null = null;
  let bestScore = 0;
  for (const [name, id] of byName) {
    if (used.has(id)) continue;
    const nameTokens = new Set(name.split(" ").filter(Boolean));
    let inter = 0;
    for (const t of keyTokens) if (nameTokens.has(t)) inter++;
    const union = new Set([...keyTokens, ...nameTokens]).size;
    const score = union ? inter / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return bestScore >= 0.55 ? best : null;
}

// ── R2 read / write ────────────────────────────────────────────────────────

/** Read the cached restriction map for the hot path (null if never scraped). */
export async function readPaultonsRestrictions(
  bucket: R2Bucket,
  park: string,
): Promise<RestrictionMap | null> {
  const obj = await bucket.get(restrictionsKey(park));
  if (!obj) return null;
  try {
    return (await obj.json()) as RestrictionMap;
  } catch {
    return null;
  }
}

/** Fold a restriction map onto a synthesised catalog's items (by ride id). */
export function applyRestrictions(
  items: Record<string, RideMeta>,
  map: RestrictionMap,
): void {
  for (const [idStr, r] of Object.entries(map)) {
    const item = items[idStr];
    if (!item) continue;
    if (r.minHeight != null) item.minHeight = r.minHeight;
    if (r.minHeightUnaccompanied != null) item.minHeightUnaccompanied = r.minHeightUnaccompanied;
    if (r.minAge != null) item.minAge = r.minAge;
    if (r.minAgeUnaccompanied != null) item.minAgeUnaccompanied = r.minAgeUnaccompanied;
  }
}

// ── Daily refresh (off the hot path) ───────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** The accessibility ride-page slugs, from the site's sitemap. */
async function fetchSlugs(): Promise<string[]> {
  const xml = await fetchText(`${SITE}/sitemap.xml`);
  if (!xml) return [];
  const slugs = new Set<string>();
  for (const m of xml.matchAll(/accessibility\/rides\/([a-z0-9-]+)/g)) slugs.add(m[1]);
  return [...slugs];
}

/** The feed's current rideId ↔ name pairs, for joining slugs to ids. */
async function fetchFeedNames(cfg: FirstOptionConfig): Promise<Map<string, number>> {
  const byName = new Map<string, number>();
  let resp: Response;
  try {
    resp = await fetch(`${cfg.apiUrl}/api/queue-times`, {
      headers: { "x-token": cfg.token, "is-mobile": "true", "user-agent": USER_AGENT },
    });
  } catch {
    return byName;
  }
  if (!resp.ok) return byName;
  let rows: { rideId?: number; ride?: { name?: string | null } | null }[];
  try {
    rows = (await resp.json()) as typeof rows;
  } catch {
    return byName;
  }
  if (!Array.isArray(rows)) return byName;
  for (const r of rows) {
    const name = r.ride?.name?.trim();
    if (typeof r.rideId === "number" && name) byName.set(normalise(name), r.rideId);
  }
  return byName;
}

/**
 * Scrape the accessibility pages, parse each into a Restriction, join to the
 * feed's ride ids, and cache the `rideId → Restriction` map in R2. Runs on the
 * daily pre-open cron and `/poll`. Never throws; on any failure (sitemap, feed,
 * or an empty scrape) it leaves the existing cached map untouched so a bad run
 * never wipes restrictions. Returns the number of rides mapped (−1 if skipped).
 */
export async function refreshPaultonsRestrictions(
  bucket: R2Bucket,
  park: string,
  cfg: FirstOptionConfig,
): Promise<number> {
  const [slugs, byName] = await Promise.all([fetchSlugs(), fetchFeedNames(cfg)]);
  if (slugs.length === 0 || byName.size === 0) return -1; // keep last-good

  const pages = await Promise.all(
    slugs.map(async (slug) => ({
      slug,
      html: await fetchText(`${SITE}/accessibility/rides/${slug}`),
    })),
  );
  const loaded = pages.filter((p): p is { slug: string; html: string } => p.html != null);
  // A partial outage (many pages failed) would produce a smaller map that
  // overwrites the good one, silently dropping restrictions for a day. Only
  // publish when nearly every page loaded; otherwise keep the last-good map.
  if (loaded.length < Math.ceil(slugs.length * 0.9)) return -1;

  // Resolve each page to a ride id — exact matches first (across all pages), then
  // fuzzy for the rest, never assigning one ride id to two pages.
  const used = new Set<number>();
  const resolved: { rideId: number; html: string }[] = [];
  const pending: { slug: string; html: string }[] = [];
  for (const { slug, html } of loaded) {
    const id = exactRideId(slug, byName, used);
    if (id != null) {
      used.add(id);
      resolved.push({ rideId: id, html });
    } else {
      pending.push({ slug, html });
    }
  }
  for (const { slug, html } of pending) {
    const id = fuzzyRideId(slug, byName, used);
    if (id == null) continue;
    used.add(id);
    resolved.push({ rideId: id, html });
  }

  const map: RestrictionMap = {};
  for (const { rideId, html } of resolved) {
    const restr = parseRestrictionPage(html);
    if (Object.keys(restr).length > 0) map[rideId] = restr;
  }

  if (Object.keys(map).length === 0) return -1; // parsed nothing — keep last-good
  await bucket.put(restrictionsKey(park), JSON.stringify(map), {
    httpMetadata: { contentType: "application/json" },
  });
  return Object.keys(map).length;
}
