import {
  MERLIN_PASS_KEY,
  RESTRICTION_PASS_IDS,
  RESTRICTIONS_API,
  RESTRICTIONS_PAGE,
  USER_AGENT,
} from "./config";
import { logPoll } from "./db";
import { buildPassIcals, passIcalKey, writeIcal } from "./ical";
import type { Env } from "./types";

/**
 * Merlin Annual Pass entry restrictions — the dates a pass tier is refused entry.
 *
 * Unlike every other stream here this belongs to the pass, not to a park: one
 * calendar covers the whole estate, so it's polled once and filed under the
 * pseudo-park key `merlin`. Two uses:
 *
 *  - For a passholder it's the first question about a date, so the calendar can
 *    answer "is it open, is there a ticket, and does my pass get in" in one cell.
 *  - For us it's independent evidence about a date. A day where every tier but
 *    the top one is blocked is a day the estate is shut to passholders, which is
 *    the buyout shape — and the calendar runs to the end of NEXT year, far past
 *    the ticket catalog, so those days are published long before any package
 *    names them. anomalies.ts uses that to corroborate the dates it can't
 *    otherwise explain.
 *
 * See docs/merlin-pass-restrictions.md.
 */

export interface RestrictionTier {
  name: string; // "Gold Pass", "Discovery Pass", …
  /** The site's own swatch for the tier, when it publishes one. */
  color?: string;
}

export interface RestrictionsFile {
  generated_at: string;
  /** Every tier the calendar covers, in the site's order — the denominator for
   *  reading a date's blocked list (see blackoutDates). */
  tiers: RestrictionTier[];
  /** First and last date the published calendar covers, so a reader can tell
   *  "no restriction" from "not published yet". */
  span: [string, string];
  /** date ('YYYY-MM-DD') → the tiers refused entry. Only dates with at least one. */
  days: Record<string, string[]>;
}

const RESTRICTIONS_KEY = `calendar/${MERLIN_PASS_KEY}/restrictions.json`;

const HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-GB,en;q=0.9",
  "user-agent": USER_AGENT,
};

const isoFromKey = (key: string): string | null =>
  /^\d{8}$/.test(key) ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}` : null;

/**
 * The live list of pass ids, read from the restriction-dates page's Vue tag:
 * `<passtype-restrictions-dates passes="<guid>,<guid>,…">`. Tiers rotate (Merlin
 * added "Essential", and dropped "Silver" from GetPassTypes while its id still
 * names dates), so the page is the source of truth and the config list is only a
 * fallback. Never throws — a failed scrape falls back.
 */
export async function discoverPassIds(): Promise<string[]> {
  try {
    const resp = await fetch(RESTRICTIONS_PAGE, {
      headers: { ...HEADERS, accept: "text/html,application/xhtml+xml" },
    });
    if (!resp.ok) return RESTRICTION_PASS_IDS;
    const html = await resp.text();
    const m = /<passtype-restrictions-dates[^>]*\spasses="([^"]+)"/i.exec(html);
    const ids = (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
    return ids.length ? ids : RESTRICTION_PASS_IDS;
  } catch {
    return RESTRICTION_PASS_IDS;
  }
}

/** GetPassTypes: name + swatch per id. Only used for the colour — a tier missing
 *  here still names dates, so this never gates the poll. */
interface ApiPassType {
  id?: string;
  name?: string;
  color?: string;
}

/** GetEntryRestrictionDates: one entry per day across the published span, with
 *  the tiers blocked that day (empty on an unrestricted day). `filters` is the
 *  full tier list for the ids we asked about — the authoritative set, since it
 *  includes tiers GetPassTypes omits. */
interface ApiRestrictionDates {
  filters?: string[];
  startDate?: string; // "2025-02-15T00:00:00"
  endDate?: string;
  entryRestrictionDatesElements?: { key?: string; passTypes?: string[] }[];
}

export interface RestrictionsFetch {
  ok: boolean;
  httpStatus: number;
  file: Omit<RestrictionsFile, "generated_at"> | null;
  datesSeen: number;
}

/** Fetch and assemble the restriction calendar. Never throws. */
export async function fetchRestrictions(): Promise<RestrictionsFetch> {
  const fail = (httpStatus: number): RestrictionsFetch => ({
    ok: false,
    httpStatus,
    file: null,
    datesSeen: 0,
  });

  const ids = (await discoverPassIds()).join(",");
  // Caught separately, not by one Promise.all: the dates response carries
  // everything essential and the colours are decoration, so a GetPassTypes that
  // fails (or throws) must cost the tiers their swatches, not fail the poll.
  const [typesResp, datesResp] = await Promise.all([
    fetch(`${RESTRICTIONS_API}/GetPassTypes?passRestrictionIds=${ids}&culture=en-GB`, {
      headers: HEADERS,
    }).catch(() => null),
    fetch(
      `${RESTRICTIONS_API}/GetEntryRestrictionDates?passRestrictionIds=${ids}` +
        `&useInvertedDates=false&culture=en-GB`,
      { headers: HEADERS },
    ).catch(() => null),
  ]);
  if (!datesResp) return fail(0);
  if (!datesResp.ok) return fail(datesResp.status);

  let dates: ApiRestrictionDates;
  try {
    dates = (await datesResp.json()) as ApiRestrictionDates;
  } catch {
    return fail(datesResp.status);
  }
  const elements = dates.entryRestrictionDatesElements;
  if (!Array.isArray(elements) || elements.length === 0) return fail(datesResp.status);

  const colors = new Map<string, string>();
  if (typesResp?.ok) {
    try {
      for (const t of (await typesResp.json()) as ApiPassType[]) {
        if (t?.name && t.color) colors.set(t.name, t.color);
      }
    } catch {
      /* decoration only */
    }
  }

  const days: Record<string, string[]> = {};
  let min = "";
  let max = "";
  for (const el of elements) {
    const iso = isoFromKey(String(el.key ?? ""));
    if (!iso) continue;
    if (!min || iso < min) min = iso;
    if (iso > max) max = iso;
    const tiers = (el.passTypes ?? []).filter(Boolean);
    if (tiers.length) days[iso] = tiers;
  }
  if (!min) return fail(datesResp.status);

  // `filters` is the tier list for the ids we asked about; fall back to the
  // names actually seen on dates if the field ever goes missing, so "every tier
  // blocked" can still be computed.
  const names = dates.filters?.length
    ? dates.filters
    : [...new Set(Object.values(days).flat())].sort();

  return {
    ok: true,
    httpStatus: datesResp.status,
    file: {
      tiers: names.map((name) => ({
        name,
        ...(colors.get(name) ? { color: colors.get(name)! } : {}),
      })),
      span: [min, max],
      days,
    },
    datesSeen: elements.length,
  };
}


/**
 * Poll the restriction calendar and overwrite the served R2 file. Like the hours
 * poll there's no delta log: the whole calendar is a few KB and changes rarely,
 * so it's rewritten wholesale, and a failed fetch leaves the last good file in
 * place. Returns the number of restricted dates now published.
 */
export async function refreshRestrictions(env: Env, now: number): Promise<number> {
  const observedAt = new Date(now).toISOString();
  const res = await fetchRestrictions();
  let restricted = 0;
  if (res.ok && res.file) {
    restricted = Object.keys(res.file.days).length;
    const body: RestrictionsFile = { generated_at: observedAt, ...res.file };
    await env.BUCKET.put(RESTRICTIONS_KEY, JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    });
    // Subscribable form of the same calendar, one feed per level. From the start
    // of the current month, so a subscriber's calendar doesn't carry last year.
    await Promise.all(
      buildPassIcals(body, `${observedAt.slice(0, 7)}-01`, observedAt).map((feed) =>
        writeIcal(env.BUCKET, passIcalKey(feed.slug), feed.body),
      ),
    );
  }
  await logPoll(
    env.DB,
    MERLIN_PASS_KEY,
    "restrictions",
    res.httpStatus,
    res.ok ? "OK" : "FAILED",
    restricted,
    res.datesSeen,
    observedAt,
  );
  return restricted;
}

/** The served file, for the jobs that read it (anomalies). Null when it hasn't
 *  been written yet or can't be parsed. */
export async function readRestrictions(bucket: R2Bucket): Promise<RestrictionsFile | null> {
  const obj = await bucket.get(RESTRICTIONS_KEY);
  if (!obj) return null;
  try {
    const f = (await obj.json()) as RestrictionsFile;
    return f.days && f.tiers?.length ? f : null;
  } catch {
    return null;
  }
}

/**
 * The dates where at most the single top tier is admitted — the estate is shut
 * to passholders.
 *
 * "All but one" rather than "all", because that is where the line actually falls
 * in the published calendar. Three shapes appear in it:
 *
 *   Christmas Day       all five tiers blocked          the parks are closed
 *   First Nov weekend   all but Platinum blocked        the partner buyout days
 *   School peaks        Essential/Silver/Discovery      an ordinary busy day
 *
 * Only the first two mean the day isn't a normal trading day, and the second is
 * the one worth having: 2026-11-06/07/08 are exactly the dates special-days.ts
 * identifies at Thorpe from the exchange catalog (John Lewis, Blue Light Card),
 * and 2027-11-05/06/07 are already published here with no package in existence.
 *
 * The `>= 3` guard keeps the rule from degenerating if the feed ever returns a
 * one- or two-tier list, where "all but one" would match an ordinary exclusion.
 */
export function blackoutDates(file: RestrictionsFile): Set<string> {
  const all = file.tiers.length;
  const out = new Set<string>();
  if (all < 3) return out;
  for (const [iso, tiers] of Object.entries(file.days)) {
    if (new Set(tiers).size >= all - 1) out.add(iso);
  }
  return out;
}
