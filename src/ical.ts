import { SITE_ORIGIN } from "./config";
import type { HoursDay, HoursSnapshot } from "./hours";
import type { RestrictionsFile } from "./restrictions";

/**
 * iCalendar (RFC 5545) feeds, so a park's calendar and the pass restrictions can
 * be subscribed to rather than visited.
 *
 * Two shapes, both generated from data the poller already holds and written to
 * R2 as whole objects:
 *
 *   ical/<park>.ics        one event per open day — hours, special event,
 *                          buyout, and (Merlin parks) the day's pass restriction
 *   ical/pass/<slug>.ics   one all-day event per restricted date, per pass level,
 *                          plus `all` covering every level in one feed
 *
 * Calendar clients refetch on their own schedule and ignore what they were served
 * last, so the feeds are precomputed rather than assembled per request.
 */

const CRLF = "\r\n";

/** How often a client should refetch. Hours move at most hourly (the poll's own
 *  cadence); restrictions change a few times a year. */
const REFRESH_HOURS = "PT6H";
const REFRESH_PASS = "P1D";

/* ── RFC 5545 plumbing ─────────────────────────────────────────────────────── */

/** Escape a TEXT value (§3.3.11). Backslash first, or it re-escapes the escapes. */
const esc = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/[;,]/g, "\\$&").replace(/\r?\n/g, "\\n");

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/**
 * Fold a content line to 75 octets (§3.1), continuing with CRLF + one space.
 * Measured in UTF-8 bytes but split on character boundaries: a fold through the
 * middle of a multi-byte character is legal by the letter of the spec and
 * mangles the text in several real clients.
 */
function fold(line: string): string {
  if (utf8Len(line) <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    if (utf8Len(cur) + utf8Len(ch) > limit) {
      out.push(cur);
      cur = ch;
      limit = 74; // the leading space costs an octet on continuation lines
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

const ymdCompact = (iso: string): string => iso.replace(/-/g, "");

/** Shift an ISO date by whole days — DTEND on an all-day event is exclusive. */
const isoAddDays = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** A UTC timestamp as iCal wants it: 20260914T140343Z. */
const stamp = (isoInstant: string): string =>
  `${isoInstant.slice(0, 19).replace(/[-:]/g, "")}Z`;

/**
 * Europe/London. Emitted only when a feed carries timed events.
 *
 * Park hours are local wall-clock strings ("10am - 6pm"), so the times have to be
 * anchored to the zone: floating times render as 10am wherever the subscriber
 * happens to be, and a UTC conversion is wrong for half the year.
 */
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "TZNAME:BST",
  "DTSTART:19700329T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "TZNAME:GMT",
  "DTSTART:19701025T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

interface VEvent {
  /** Stable per (feed, date) — a UID that moved would duplicate the event on
   *  every refresh instead of updating it, which is the classic way to make a
   *  subscribed calendar unusable. */
  uid: string;
  /** ISO date for an all-day event; [start, end] wall-clock minutes for a timed
   *  one, where `end` may run past 1440 for an after-midnight close. */
  date: string;
  times?: { start: number; end: number };
  summary: string;
  description?: string[];
  url?: string;
  location?: string;
}

const hhmm = (mins: number): string =>
  `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}${String(mins % 60).padStart(2, "0")}`;

function renderEvent(e: VEvent, dtstamp: string): string[] {
  const lines = [`BEGIN:VEVENT`, `UID:${e.uid}`, `DTSTAMP:${dtstamp}`];
  if (e.times) {
    // A close past midnight belongs to the next calendar day.
    const endDate = e.times.end >= 1440 ? isoAddDays(e.date, 1) : e.date;
    lines.push(
      `DTSTART;TZID=Europe/London:${ymdCompact(e.date)}T${hhmm(e.times.start)}00`,
      `DTEND;TZID=Europe/London:${ymdCompact(endDate)}T${hhmm(e.times.end)}00`,
    );
  } else {
    lines.push(
      `DTSTART;VALUE=DATE:${ymdCompact(e.date)}`,
      // Exclusive, so a one-day event ends on the following date.
      `DTEND;VALUE=DATE:${ymdCompact(isoAddDays(e.date, 1))}`,
    );
  }
  lines.push(`SUMMARY:${esc(e.summary)}`);
  if (e.description?.length) lines.push(`DESCRIPTION:${esc(e.description.join("\n"))}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  // Nothing here is an appointment: a subscribed park calendar must not make
  // the subscriber look busy to anyone checking their availability.
  lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  return lines;
}

function renderCalendar(opts: {
  name: string;
  description: string;
  refresh: string;
  events: VEvent[];
  dtstamp: string;
  timed: boolean;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//merlin-capacity//${SITE_ORIGIN.replace(/^https?:\/\//, "")}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(opts.name)}`,
    `X-WR-CALDESC:${esc(opts.description)}`,
    "X-WR-TIMEZONE:Europe/London",
    `REFRESH-INTERVAL;VALUE=DURATION:${opts.refresh}`,
    `X-PUBLISHED-TTL:${opts.refresh}`,
    ...(opts.timed ? VTIMEZONE : []),
    ...opts.events.flatMap((e) => renderEvent(e, opts.dtstamp)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join(CRLF) + CRLF;
}

/* ── Park calendar ─────────────────────────────────────────────────────────── */

/**
 * "10am - 6pm" → minutes since midnight. Every source is normalised to this
 * style by hours.ts (Blackpool's "10:00am" and Paulton's "10:00" both arrive
 * here as "10am"), but the 24-hour form is accepted too — the Merlin sites have
 * used both. An end at or before the start is a close after midnight, so it
 * carries into the next day rather than producing a negative-length event.
 */
export function parseHoursRange(s: string): { start: number; end: number } | null {
  const text = s.trim();
  if (!text || /^closed$/i.test(text)) return null;
  const clock = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
  const m = new RegExp(`^${clock}\\s*[-–—]\\s*${clock}$`, "i").exec(text);
  if (!m) return null;

  const at = (h: string, min: string | undefined, ampm: string | undefined): number | null => {
    let hour = Number(h);
    const mins = Number(min ?? "0");
    if (!Number.isFinite(hour) || hour > 23 || mins > 59) return null;
    const period = ampm?.toLowerCase();
    if (period === "pm" && hour !== 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
    return hour * 60 + mins;
  };
  const start = at(m[1], m[2], m[3]);
  let end = at(m[4], m[5], m[6]);
  if (start === null || end === null) return null;
  if (end <= start) end += 1440;
  return { start, end };
}

/** A ticket package name tidied into a day label — "1 Day Pass - VodafoneThree
 *  Big Day Out" is a thing you buy, "VodafoneThree Big Day Out" is what the day
 *  is. Mirrors `specialLabel` in frontend/src/api.ts; kept separate because the
 *  Worker and the browser bundle share no module. */
export function specialLabel(name: string): string {
  const short = name
    .replace(/^\s*\d+\s*day\s*(pass|ticket|entry)\s*[-–—:]\s*/i, "")
    .replace(/\s*[-–—:]?\s*(entry|ticket|pass)\s*$/i, "")
    .trim();
  return short || name;
}

/** "Gold Pass" → "Gold". Every level ends in "Pass", so the word carries nothing
 *  in a list of them and costs a calendar summary its readable width. */
const tierShort = (name: string): string => name.replace(/\s*pass\s*$/i, "").trim();

/**
 * How a date's blocked pass levels read in one line. Mirrors
 * `restrictionSummary` in frontend/src/api.ts — naming four of five levels
 * buries the point, so a near-total block says what still gets in. The full
 * names go in the event's description; this is the summary.
 */
export function restrictionLabel(blocked: string[], tiers: string[]): string {
  const left = tiers.filter((t) => !blocked.includes(t));
  if (tiers.length >= 3 && left.length === 0) return "All pass levels restricted";
  if (tiers.length >= 3 && left.length === 1) {
    return `All pass levels but ${tierShort(left[0])} restricted`;
  }
  return `${blocked.map(tierShort).join(", ")} restricted`;
}

export interface SpecialDaysLike {
  days?: Record<string, { name: string }>;
}

export interface ParkIcalInput {
  parkKey: string;
  parkLabel: string;
  /** The hours poll's own snapshot — already in memory, so the feed costs no
   *  extra reads of the month files it was just written from. */
  snapshot: HoursSnapshot;
  /** Buyout / private-event days, read from calendar/<park>/special.json. */
  special: SpecialDaysLike | null;
  /** Pass restrictions, for a Merlin park. */
  restrictions: RestrictionsFile | null;
  /** Earliest date to publish — dropping settled history keeps the feed small
   *  and stops a subscriber's calendar filling with last year. */
  from: string;
  generatedAt: string;
}

/** One day's event, or null when the park does nothing that day (a closed day
 *  is best expressed by the calendar being empty, not by a "Closed" event). */
function parkEvent(
  iso: string,
  day: HoursDay | undefined,
  input: ParkIcalInput,
): VEvent | null {
  const { parkKey, parkLabel } = input;
  const uid = `${parkKey}-${iso}@${SITE_ORIGIN.replace(/^https?:\/\//, "")}`;
  const url = `${SITE_ORIGIN}/${parkKey}`;
  const base = { uid, date: iso, location: parkLabel, url };
  const desc: string[] = [];

  const isOpen = (h: string) => !!h.trim() && !/^closed$/i.test(h.trim());
  const locations = day?.locations ?? [];
  for (const l of locations) {
    desc.push(`${l.name || l.kind}: ${l.hours || "Closed"}${l.lastEntry ? ` (${l.lastEntry})` : ""}`);
  }
  for (const e of day?.events ?? []) desc.push(`${e.time ?? "All day"} — ${e.name}`);

  const blocked = input.restrictions?.days[iso];
  if (blocked?.length) {
    desc.push(restrictionLabel(blocked, input.restrictions!.tiers.map((t) => t.name)));
  }

  // A buyout outranks the hours: the park publishes none for these days, and
  // what the day IS is the only thing worth saying about it.
  const special = input.special?.days?.[iso];
  if (special) {
    return {
      ...base,
      summary: `${parkLabel} · ${specialLabel(special.name)}`,
      description: ["Closed to the public — private or separately-ticketed event.", ...desc],
    };
  }

  const themepark = locations.find((l) => l.kind === "themepark" && isOpen(l.hours));
  const primary = themepark ?? locations.find((l) => isOpen(l.hours));
  if (primary) {
    const times = parseHoursRange(primary.hours);
    const suffix = day?.event
      ? ` · ${day.event}`
      : primary.kind === "themepark"
        ? ""
        : ` · ${primary.name || primary.kind}`;
    return {
      ...base,
      summary: `${parkLabel}${suffix}`,
      // An unparseable hours string still makes a day worth showing; it goes out
      // as all-day with the text in the description rather than being dropped.
      ...(times ? { times } : {}),
      description: times ? desc : [`Open ${primary.hours}`, ...desc],
    };
  }

  // No hours anywhere, but the day has a lineup or a headline: an events-only
  // park (Flamingo Land), where having events IS the open-day signal.
  const headline = day?.event ?? day?.events?.[0]?.name;
  if (headline) {
    return { ...base, summary: `${parkLabel} · ${headline}`, description: desc };
  }
  // Nothing open and nothing on. A restriction alone doesn't make a park day.
  return null;
}

export function buildParkIcal(input: ParkIcalInput): string {
  const events: VEvent[] = [];
  const dates = new Set([
    ...Object.keys(input.snapshot),
    ...Object.keys(input.special?.days ?? {}),
  ]);
  for (const iso of [...dates].sort()) {
    if (iso < input.from) continue;
    const e = parkEvent(iso, input.snapshot[iso], input);
    if (e) events.push(e);
  }
  return renderCalendar({
    name: input.parkLabel,
    description: `Opening hours, events and private-event days for ${input.parkLabel}. Unofficial, from ${SITE_ORIGIN}.`,
    refresh: REFRESH_HOURS,
    events,
    dtstamp: stamp(input.generatedAt),
    timed: events.some((e) => !!e.times),
  });
}

/* ── Pass restriction feeds ────────────────────────────────────────────────── */

/** "Gold Pass" → "gold". The feed slug, and the last path segment of its URL. */
export const tierSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\s*pass\s*$/, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-");

export interface PassFeed {
  slug: string;
  /** Display name, for the Links tab and X-WR-CALNAME. */
  name: string;
  body: string;
}

/**
 * One feed per pass level, plus `all` covering every level at once. A level's
 * feed carries only the dates it is actually refused entry on, which is the
 * whole point: subscribe to your own level and the calendar shows the days you
 * can't go.
 */
export function buildPassIcals(
  file: RestrictionsFile,
  from: string,
  generatedAt: string,
): PassFeed[] {
  const dtstamp = stamp(generatedAt);
  const host = SITE_ORIGIN.replace(/^https?:\/\//, "");
  // The restrictions are estate-wide, so an event links to the site rather than
  // to any one park's calendar.
  const url = SITE_ORIGIN;
  const tiers = file.tiers.map((t) => t.name);
  const dates = Object.keys(file.days)
    .filter((iso) => iso >= from)
    .sort();

  const feeds: PassFeed[] = tiers.map((tier) => ({
    slug: tierSlug(tier),
    name: tier,
    body: renderCalendar({
      name: `${tier} restrictions`,
      description: `Dates the ${tier} is not admitted to Merlin attractions. Unofficial, from ${SITE_ORIGIN}.`,
      refresh: REFRESH_PASS,
      dtstamp,
      timed: false,
      events: dates
        .filter((iso) => file.days[iso].includes(tier))
        .map((iso) => ({
          uid: `pass-${tierSlug(tier)}-${iso}@${host}`,
          date: iso,
          summary: `${tier} restricted`,
          description: [
            `Entry to Merlin attractions is restricted for the ${tier} on this date.`,
            `Restricted: ${file.days[iso].join(", ")}.`,
          ],
          url,
        })),
    }),
  }));

  feeds.push({
    slug: "all",
    name: "All levels",
    body: renderCalendar({
      name: "Merlin pass restrictions",
      description: `Entry restriction dates for every Merlin Annual Pass level. Unofficial, from ${SITE_ORIGIN}.`,
      refresh: REFRESH_PASS,
      dtstamp,
      timed: false,
      events: dates.map((iso) => ({
        uid: `pass-all-${iso}@${host}`,
        date: iso,
        summary: restrictionLabel(file.days[iso], tiers),
        description: [`Restricted: ${file.days[iso].join(", ")}.`],
        url,
      })),
    }),
  });
  return feeds;
}

/* ── Writing ───────────────────────────────────────────────────────────────── */

/** Everything but the generation timestamps — see writeIcal. */
const signature = (body: string): string => {
  const str = body.replace(/^DTSTAMP:.*$/gm, "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

/**
 * Write a feed, unless only its DTSTAMPs would change. The hours poll runs
 * hourly and the feeds rarely differ between runs, so comparing the substance
 * keeps the served object — and every subscriber's view of it — stable instead
 * of churning once an hour.
 */
export async function writeIcal(bucket: R2Bucket, key: string, body: string): Promise<boolean> {
  const sig = signature(body);
  const head = await bucket.head(key);
  if (head?.customMetadata?.sig === sig) return false;
  await bucket.put(key, body, {
    httpMetadata: { contentType: "text/calendar; charset=utf-8" },
    customMetadata: { sig },
  });
  return true;
}

export const parkIcalKey = (park: string) => `ical/${park}.ics`;
export const passIcalKey = (slug: string) => `ical/pass/${slug}.ics`;
