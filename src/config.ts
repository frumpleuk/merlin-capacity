/**
 * Parks and products to poll. All availability flows through the shared accesso
 * backend (HOST below), keyed by merchant id — the old per-park hosts block
 * datacenter IPs, this one does not. `GetMerchantPackageEventDates` is a
 * stateless read: no cart/session tokens required.
 *
 * `event_id`/`id` (package) values rotate over time and eventually return
 * status:FAILED — refresh them from the live booking site when a product stops
 * returning data (watch the poll_log table). Sending a superset of old+new
 * package ids is fine; the API uses whichever are valid per date.
 */
/** The Merlin parks' accesso stack. Another stack (Drayton Manor's) sets
 *  `ParkConfig.accessoApi`. */
export const MEG_EU_API = "https://ecomm.api.meg-eu.accessoticketing.com";

export const HOST = `${MEG_EU_API}/api/request/getmerchantpackageeventdates`;

/** A park's GetMerchantPackageEventDates endpoint. */
export const eventDatesUrl = (park: { accessoApi?: string }) =>
  `${park.accessoApi ?? MEG_EU_API}/api/request/getmerchantpackageeventdates`;

/** The public, unauthenticated catalog blob for a park (see docs/accesso-api.md).
 *  We derive main-ticket package ids from this instead of hardcoding them. */
export const bootstrapUrl = (slug: string, api: string = MEG_EU_API) =>
  `${api}/static-api/bootstrap?m=${slug}&l=en-gb`;

/** Same endpoint for an exchange merchant. The `merchant_id` parameter is what
 *  makes it serve the real catalog: with the slug alone it answers a shell whose
 *  `merchantId` is -1 and whose package list is empty. */
export const exchangeBootstrapUrl = (slug: string, merchantId: string) =>
  `${bootstrapUrl(slug)}&merchant_id=${merchantId}`;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Fetch a full year ahead. The API only returns dates that are actually on
// sale (currently ~5–6 months out), so this doesn't inflate responses — it just
// stops us truncating what IS on sale (e.g. Legoland into late December) and
// auto-captures next year's dates as each park releases them.
export const HORIZON_DAYS = 365;

/** Where this deployment is served from (the `routes` entry in wrangler.toml).
 *  Used to build absolute URLs in things that leave the site — the iCal feeds
 *  carry it in UIDs, which must not move, and in each event's link back. */
export const SITE_ORIGIN = "https://themeparks.frumple.co.uk";

/* ── Merlin Annual Pass entry restrictions ─────────────────────────────────────
 *
 * The dates a given pass tier is refused entry. Published by the pass site, not
 * by a park, and it applies across the whole Merlin estate — so it's polled once
 * and filed under the pseudo-park key `merlin` (NOT a ParkConfig; nothing else
 * keys off it). See src/restrictions.ts and docs/merlin-pass-restrictions.md.
 */

/** The pass site's page carrying the restriction calendar. Its
 *  `<passtype-restrictions-dates passes="…">` attribute is the live list of pass
 *  ids, which is what we read rather than trusting the seed below. */
export const RESTRICTIONS_PAGE =
  "https://www.merlinannualpass.co.uk/important-information/terms-conditions/restriction-dates/";

/** The Umbraco API the page's Vue component calls. Unauthenticated GETs. */
export const RESTRICTIONS_API =
  "https://www.merlinannualpass.co.uk/umbraco/api/EntryRestrictionDates";

/**
 * Seed pass ids, used only when the page scrape fails. Tiers rotate — Merlin
 * added "Essential" and stopped publishing "Silver" in GetPassTypes while its
 * id still names dates — so the scrape is the source of truth and this is the
 * last-resort fallback (a stale id costs one missing tier, not a failed poll).
 */
export const RESTRICTION_PASS_IDS = [
  "497a9da9-9387-431c-a56e-350dee6ef877", // Essential
  "2b1836f9-741b-48e4-8c85-1cdd0b33faae", // Gold
  "ab93e3ae-5c8a-4f2c-aed7-b8647dc97ac8", // Platinum
  "498cd0c1-24dc-4717-a4ef-a2685a70890c", // Silver
  "2f04d5ac-ac4f-45d3-b599-bc02af7a5614", // Discovery
];

/** R2 / poll-log key the estate-wide restriction stream is filed under. */
export const MERLIN_PASS_KEY = "merlin";


/** Attractions.io ("Occasio") identity for a park — powers ride names + live
 *  queue times (see docs/attractions-io-api.md). `apiKey` is the app's public
 *  per-park UUID (live-feed filename + Authorization); `slug` is the content
 *  bundle path segment. Both are app-embedded client identifiers, not secrets. */
/** Every app-embedded key below (`apiKey`, `token`, `clientSecret`) is left
 *  empty here and filled in from the APP_KEYS secret (app-keys.ts). */
export interface AttractionsConfig {
  apiKey: string;
  slug: string;
}

/** First Option Software backend — the queue-time source for Paulton's Park.
 *  Paulton's is independent (no accesso) and, unlike the Merlin parks, its
 *  guest app is a Capacitor web app whose queue times come from this custom
 *  vendor API (NOT the Attractions.io live feed — Attractions.io only runs
 *  Paulton's internal wait-time management/signage). See docs/paultons-api.md.
 *  `token` is the app-embedded static `x-token` value; `apiUrl` the host. */
export interface FirstOptionConfig {
  apiUrl: string;
  token: string;
}

/** Firebase/Firestore backend — the queue-time source for Flamingo Land. Like
 *  Paulton's it's an independent (non-accesso) park whose guest app is a
 *  Capacitor web app, but the waits live in a Cloud Firestore collection
 *  (`rides_data`) rather than a bespoke REST API. Reads require a Firebase ID
 *  token; the app enables ANONYMOUS auth, so we mint one anonymous user with the
 *  app-embedded web `apiKey` and reuse it (cached + refreshed in R2). Ride names
 *  are inline on each doc, so — like `fos` — there's no content bundle / catalog
 *  cron. See docs/flamingoland-api.md. */
export interface FirebaseConfig {
  projectId: string;
  apiKey: string;
  /** Firestore collection holding one doc per ride (with `queue_time`). */
  collection: string;
}

/** Blackpool Pleasure Beach backend — a bespoke Laravel REST API. Like Paulton's
 *  and Flamingo Land it's an independent park, and ride names arrive inline with
 *  the feed (no content bundle). Unlike them, reads require a per-USER Sanctum
 *  bearer token (there's no app-embedded static token or anonymous auth), so we
 *  log in with a dedicated account whose credentials live in Worker secrets
 *  (`BPB_EMAIL`/`BPB_PASSWORD`, see Env) — only the host is configured here. The
 *  token is cached/refreshed in R2. See docs/blackpool-api.md. */
export interface BpbConfig {
  apiUrl: string;
}

/** Disneyland Paris backend. Waits come from an AWS API Gateway feed
 *  (`dlp-wt.wdprapps.disney.com`) behind a static `x-api-key` embedded in the
 *  app's Hermes bundle; ride names, lands and height limits come from the
 *  unauthenticated GraphQL API the app and website share. One feed covers both
 *  parks, each entry tagged with its `parkId`, so each park filters to its own.
 *  See docs/disneylandparis-api.md. */
export interface DlpConfig {
  waitTimesUrl: string;
  apiKey: string;
  graphqlUrl: string;
  /** The park's activity id: "P1" Disneyland Park, "P2" Disney Adventure World. */
  parkId: string;
}

/** accesso's TE2 app platform (Drayton Manor). Reads need an anonymous OAuth
 *  token from accesso's global-auth server, granted to the app's own client id
 *  and secret from its Hermes bundle. App-embedded identifiers like DLP's
 *  `apiKey`, not account credentials. See docs/drayton-api.md. */
export interface Te2Config {
  /** API host; paths sit under `/api/`. */
  apiUrl: string;
  /** global-auth token endpoint. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Venue and app id ("DMR_BG"), sent as the `appID` header too. */
  venueId: string;
  /** Organisation, sent as `X-Customer-ID`. */
  customerId: string;
}

/** Where a queue-tracked park's live ride waits come from. A discriminated
 *  union: most parks are `attractions` (Attractions.io live feed + content
 *  bundle); Paulton's is `fos` (First Option Software custom backend); Flamingo
 *  Land is `firestore` (Firebase Cloud Firestore); Blackpool is `bpb` (bespoke
 *  Laravel API, per-user token). `fos`, `firestore`, and `bpb` all carry ride
 *  names inline, so none needs a content bundle / catalog cron. */
export type QueueSource =
  | ({ kind: "attractions" } & AttractionsConfig)
  | ({ kind: "fos" } & FirstOptionConfig)
  | ({ kind: "firestore" } & FirebaseConfig)
  | ({ kind: "bpb" } & BpbConfig)
  | ({ kind: "dlp" } & DlpConfig)
  | ({ kind: "te2" } & Te2Config);

export const liveFeedUrl = (apiKey: string) =>
  `https://live-data.attractions.io/${apiKey}.json`;

export const ATTRACTIONS_API = "https://api.attractions.io";

/** A location within a park's opening-hours calendar. `id` is accesso's
 *  locationId; `kind` drives the icon shown in the UI. */
export interface OpeningHoursLocation {
  id: string;
  kind: "themepark" | "waterpark" | "golf";
}

/** Where and how to read a park's opening hours. A discriminated union by source:
 *
 *  - `accesso`: the Merlin marketing sites' unauthenticated `getcalendar`
 *    endpoint (needs a browser UA — a short UA 403s). `lastEntryTime` on each day
 *    is overloaded: sometimes a genuine last-entry note, sometimes a special-event
 *    name — classified in hours.ts.
 *  - `bpb`: Blackpool exposes its whole forward calendar as a JSON API
 *    (park-dates-times/v2) — one object per open date, carrying the same hours +
 *    events the marketing site renders inline. No auth or header gotchas. Same
 *    shared `HoursSnapshot` output. See docs/blackpool-api.md §6.
 *  - `paultons`: Paulton's publishes its calendar as two plain JSON blobs — a
 *    `times` array (`{open,closed,dates[]}`, 24h local) and a date-range
 *    `special-events` array (unix-second start/end + name). Unauthenticated
 *    nginx, no header gotchas. Powers both the hours calendar AND the queue
 *    sparkline's opening-window x-axis (fetchPaultonsWindow in queues.ts).
 *  - `flamingoland`: no opening-hours feed exists, so this falls back to special
 *    events — The Events Calendar (Tribe) plugin's public iCal feed, paged into a
 *    rolling What's-On calendar (no per-day hours, just a `DayEvent` lineup +
 *    headline). See docs/flamingoland-calendar.md.
 *  - `dlp`: Disneyland Paris GraphQL `activitySchedules`, one date per field,
 *    every date aliased into one request. Each park day has an OPERATING slot and
 *    usually an EXTRA_MAGIC_HOURS slot before it. See docs/disneylandparis-api.md.
 *  - `knoebels`: the park site's WordPress route `knoebels/v1/hours?day=`, one
 *    request per date. Its month calendar route marks event days but carries no
 *    times, so the window is fetched a day at a time.
 *  - `pleasurewood`: the opening-times page embeds the whole season as two
 *    inline JS arrays, `openArr` (date ranges with "HH:MM-HH:MM" times, blank
 *    meaning 10:00-17:00) and `eventArr` (named date ranges). One request.
 *  - `crealy`: the Umbraco surface route `OpeningTimesCalendar/RenderMonth`
 *    returns one month of day buttons (`data-date`, hours, an event banner,
 *    last entry). One request per month.
 *  - `te2`: accesso's TE2 app API (Drayton Manor), `venue-hours` for the days
 *    and `calendars/events` for named events, behind the same anonymous token
 *    as its queues. */
export type OpeningHoursConfig =
  | {
      kind: "accesso";
      calendarUrl: string;
      locations: OpeningHoursLocation[];
    }
  | {
      kind: "bpb";
      /** The park-dates-times JSON API (one entry per open date). */
      apiUrl: string;
      /** Display name for the single themepark location row. */
      locationName: string;
    }
  | {
      kind: "paultons";
      /** Structured opening times: `[{open,closed,dates[]}]` (24h local). */
      timesUrl: string;
      /** Date-range special events: `[{start,end,tag,name}]` (unix seconds). */
      eventsUrl: string;
      /** Display name for the single themepark location row. */
      locationName: string;
    }
  | {
      kind: "dlp";
      /** The GraphQL endpoint. One request carries every date as an aliased
       *  `activitySchedules` field. */
      graphqlUrl: string;
      parkId: string;
      locationName: string;
    }
  | {
      kind: "flamingoland";
      /** The Events Calendar iCal list endpoint (`tribe-bar-date` + `ical=1` are
       *  appended per page). No opening-hours feed exists, so this drives a
       *  What's-On calendar instead. See docs/flamingoland-calendar.md. */
      icalUrl: string;
      /** How many days ahead to try to cover (rolling window). Default 15. */
      windowDays?: number;
      /** Max iCal pages per poll — a subrequest backstop (30 events/page, dense
       *  daily schedule). Default 14. */
      maxPages?: number;
    }
  | {
      kind: "pleasurewood";
      /** The opening-times page carrying `openArr` / `eventArr`. */
      pageUrl: string;
      locationName: string;
    }
  | {
      kind: "crealy";
      /** `…/umbraco/surface/OpeningTimesCalendar/RenderMonth`. */
      monthUrl: string;
      /** The page's `data-attraction-id` and `data-home-page-id`. */
      attractionId: string;
      homePageId: string;
      /** Months to read, the current one included. */
      months: number;
      locationName: string;
    }
  | ({
      kind: "te2";
      locationName: string;
      /** The park website's own calendar page, read for its CURRENT month only
       *  and preferred over the app's feed for that month: it lists days the
       *  app marks shut (Drayton 2026-12-18) and per-day events. Its other
       *  months need a `cHash` URL, which robots.txt disallows. */
      webCalendarUrl?: string;
    } & Te2Config)
  | {
      kind: "knoebels";
      /** `…/wp-json/knoebels/v1/hours`; `?day=YYYY-MM-DD` is appended. */
      hoursUrl: string;
      /** The park's zone, for which date "today" is. */
      timeZone: string;
      /** Days ahead to fetch, today included. */
      windowDays: number;
      locationName: string;
    };

/** How to find a product's packages in the bootstrap catalog, in place of a
 *  hardcoded `P`. `event_id` is stable per park; only the package ids rotate,
 *  and this rediscovers them. Defaults match a standard day ticket. */
export interface DiscoverSpec {
  event_id: string;
  packageClass?: string; // default "Daily Tickets"
  /** The package `name`, matched EXACTLY (case/whitespace-insensitive). Default
   *  "1 Day Ticket" (Legoland's dated day ticket is "Online Saver"). Deliberately
   *  not a substring: the discount variants ("1 Day Ticket - 10% Offer",
   *  "Student 1 Day Ticket") sell from a ring-fenced sub-allocation of the same
   *  event — a few thousand seats, not the park's ~15k pool — and including one
   *  makes the API report that smaller bucket for every date it covers. The
   *  autumn dates those variants used to reach are covered by the prebook anchor
   *  below (verified 2026-08-21: dropping them loses only 0-capacity dates). */
  name?: string;
  /** Further package names to treat as the public day ticket, matched the same
   *  exact way. For a season sold under its own name rather than the usual day
   *  ticket: Thorpe's Fright Nights sells as "Fright Nights Entry", a full public
   *  retail ticket drawing on the same 15k pool, so without it every Fright
   *  Nights date returns prebook ids only and reads as "pre-book only" on the
   *  calendar. Safe to add BECAUSE it draws on the park pool: verified against
   *  2026-09-20 / 10-02 that querying it alongside "1 Day Ticket" returns the
   *  union of dates with identical numbers, no rebasing (see docs §3.1). Do not
   *  add a name whose allocation is smaller than the pool. */
  alsoNames?: string[];
  /** Also include packages whose class contains this (case-insensitive) as a
   *  "yield anchor". On dates the public day ticket isn't on sale yet — the whole
   *  autumn Fright Nights / Scarefest run, months ahead — annual-pass PREBOOK
   *  packages still are, and report the same event capacity/availability, so the
   *  date shows a figure instead of a gap. Matches "Prebook" and Alton's "AP
   *  Prebook"; on normal dates it doesn't change the numbers. "" disables. */
  anchorClassMatch?: string; // default "prebook"
  /** Match the public tickets by catalog keyword instead of class + name: every
   *  package on the event whose `keyword` list holds this, whatever its class.
   *  Drayton Manor's "Tickets" keyword spans Day Tickets, Blazing Halloween,
   *  Magical Christmas and Twixmas, each selling only its own dates, all on one
   *  pool (docs/accesso-api.md, Drayton Manor). Collects no exclusives, so the
   *  special-days job, built around Merlin's catalogs, skips the park. */
  keyword?: string;
}

export interface ProductConfig {
  key: string; // matches the R2 file: calendar/<park>/<key>.json
  /** Display name, for a product the calendar shows as its own line. Set on a
   *  SEASON product (below); 'main' and 'rap' are labelled by the frontend. */
  label?: string;
  extra_movie: string;
  include_times: boolean;
  /** Static package/customer-type selectors sent to the API. Used for products
   *  the catalog doesn't list (RAP). Exactly one of `P` / `discover` is set. */
  P?: unknown[];
  /** Or: rediscover the selectors from the catalog each TTL (main tickets). */
  discover?: DiscoverSpec;
  /** Last date this product can sell, for a product with a fixed end — a
   *  one-off special event. Past it the poll stops calling the API rather than
   *  asking, every minute, about a night that has been and gone. Omit for an
   *  open-ended product (main, RAP), which always has future dates. */
  until?: string;
  /** Independent (non-accesso) availability source: a static JSON blob of
   *  per-day capacity/availability (Paulton's `tickets/availability.json`). When
   *  set, the poll fetches this instead of the accesso API — the accesso payload
   *  fields (`extra_movie`/`include_times`/`P`/`discover`) are unused. Everything
   *  downstream (D1 delta log, month files, heatmap) is reused unchanged. */
  availabilityUrl?: string;
}

/**
 * A park's trade / reseller "exchange" storefront: a SECOND set of accesso
 * merchant ids on the same API host, which partner channels book through. It
 * carries dates the public merchant knows nothing about.
 *
 * Thorpe: merchant 107, where 2026-11-06 is the John Lewis Partnership Event and
 * 2026-11-07/08 are the Blue Light Card member days, all three absent from the
 * public merchant (105) and from the opening-hours calendar. Without this the
 * park reads as closed on days it runs for 6,000+ people.
 *
 * The slug is the public one plus "-EXCHANGE" for every park except Thorpe,
 * whose public slug is ME-TPR but whose exchange is ME-TPCHERTSEY-EXCHANGE. The
 * merchant ids are NOT derivable: Thorpe's is 105 -> 107, but Alton's partner
 * packages sit on 805 (not 807) and Legoland's are split across 700 and 704, so
 * they are listed explicitly. Discovered by scanning ids around the public one
 * and keeping those whose catalog holds partner-named packages.
 */
export interface ExchangeConfig {
  /** Merchant ids to read. More than one because a park can split its partner
   *  packages across several (Legoland: 700 and 704). */
  merchantIds: string[];
  /** Exchange storefront host, sent as origin/referer. */
  origin: string;
  /** Bootstrap slug. NOTE: the slug alone returns a shell with `merchantId: -1`
   *  and no packages; `merchant_id` must ALSO go on the query string to get the
   *  real catalog with its `E`/`CT` bindings (the POST package-list form returns
   *  both as null, see docs/accesso-api.md §3.3). */
  bootstrapSlug: string;
}

/**
 * Package classes that ARE an event in their own right, on the park's public
 * merchant. Legoland's "Passholder Day" class holds one package, also named
 * "Passholder Day", which sells exactly one date in three years: 2026-11-08,
 * 8,000 capacity against the usual 14,500. A class like this names the day
 * outright, so it is collected alongside the day-ticket exclusives and allowed
 * to name a date even when the prebook anchors also report it (see
 * refreshSpecialDays test 1).
 */
export const EVENT_CLASSES = new Set(["Passholder Day"]);

/**
 * The catalog keyword the park's own Book Now button launches
 * (`data-accesso-params="SnapWizard,package,SnapWizardAdmission,<id>"`), the
 * same at all four Merlin parks. The packages carrying it are what the public
 * booking page sells, as distinct from promo and partner packages on the same
 * pool. Legoland 2026-11-22 is the case: every one of these reads capacity 0,
 * while "Online Saver" 104488, Kellogg's and a Sky offer still report the full
 * 14,500 pool, which is all the main product's merged query can see.
 */
export const FRONT_DOOR_KEYWORD = "SnapWizardAdmission";

/** Partner-day package names, matched against the exchange catalog. Deliberately
 *  narrow and intent-revealing: these sit among hundreds of ordinary trade and
 *  discount packages on the same events, so a class or event filter doesn't
 *  separate them (only Thorpe has a dedicated partner event). Across all four
 *  parks this selects 11 packages and nothing else; "takeover" is Legoland's
 *  "SKY VIP Festive Takeover" (merchant 704), which sells only 2026-11-22. */
export const PARTNER_DAY_NAME =
  /member day|blue light|john lewis|partnership|defence discount|takeover|buyout/i;

/** Partner-day words matched against an exchange package's catalog KEYWORD, for
 *  a buyout whose name doesn't say so: "SKY VIP Festive Takeover" carries
 *  "Daily Tickets - SKY Buyout - Christmas". Narrower than PARTNER_DAY_NAME and
 *  only on the park's main day-ticket event, because keywords are noisier:
 *  "Partnerships15" tags Legoland's "15% off Merlin tickets", and "AO - Sky
 *  Buyout 26" a Father Christmas add-on on another event. */
export const PARTNER_DAY_KEYWORD = /takeover|buyout/i;

/** Exchange package classes that are add-ons, not park admission. A partner-day
 *  NAME can appear on one ("Adventure Golf - Blue Light Card"), and those must
 *  not name a date. */
export const EXCHANGE_ADDON_CLASSES = new Set([
  "Golf",
  "Fastrack",
  "Parking",
  "Photography",
  "Retail",
  "Sundry",
  "Aramark",
  "Accommodation Onsite",
  "Accommodation Offsite",
]);

export interface ParkConfig {
  key: string;
  /** Display name. Only leaves the Worker through the iCal feeds (calendar name
   *  and event summaries); the site's own nav labels live in
   *  frontend/src/catalog.ts. */
  label: string;
  /** accesso availability identity. Optional: a queue-only park (Paulton's) has
   *  no accesso backend at all. Only ever read for parks with ticket `products`,
   *  so a queue-only park simply omits them. */
  merchantId?: string;
  origin?: string;
  /** Bootstrap catalog slug (NOT the subdomain — e.g. Chessington is
   *  ME-WACHESSINGTON, not ME-CWOA). From the park's landing-page `bootstrap?m=`. */
  bootstrapSlug?: string;
  /** accesso API origin when the park isn't on the Merlin stack (MEG_EU_API).
   *  Drayton Manor: https://ecomm.api.eu.accessoticketing.com. */
  accessoApi?: string;
  /** `com-accessopassport-client` header. Default "accesso26" (Merlin); Drayton's
   *  store needs "accesso304" and answers every call with a 500 otherwise. */
  accessoClient?: string;
  /** Opening-hours source (park marketing site). Separate from the accesso
   *  availability API — a different host, endpoint, and response shape. Absent
   *  for a queue-only park (no marketing-site calendar to poll). */
  openingHours?: OpeningHoursConfig;
  /** Live queue-time source (Attractions.io or First Option). Absent = the park
   *  isn't queue-tracked. Separate backend(s) from accesso availability. */
  queue?: QueueSource;
  /** Trade / reseller merchant, when the park has one (see ExchangeConfig).
   *  Read only by the daily special-days job. */
  exchange?: ExchangeConfig;
  /** On the Merlin Annual Pass. Drives whether the estate-wide entry
   *  restrictions (src/restrictions.ts) apply to this park — set only on the
   *  Merlin parks, never inferred from `merchantId`, so a future accesso park
   *  outside the pass doesn't silently inherit them. */
  merlinPass?: boolean;
  /** accesso ticket products to poll. Empty for a queue-only park. */
  products: ProductConfig[];
  /** IANA zone the park's published times are in. Default Europe/London.
   *  Mirrors `timeZone` in frontend/src/catalog.ts. */
  timeZone?: string;
  /** Where to ask OpenWeather about (src/weather.ts): the mean of the park's
   *  mapped food venues (frontend/public/menu-data), to 3 dp. */
  weather?: { lat: number; lon: number };
}

/** A park's time zone, defaulting to the UK parks'. */
export const parkTimeZone = (park: { timeZone?: string }): string =>
  park.timeZone ?? "Europe/London";

/* ── Park days ──────────────────────────────────────────────────────────────
 *
 * A park's day is its LOCAL date, running from DAY_ROLLOVER_HOUR to the same
 * hour the next morning, so a late opening (a Halloween night to 01:00) stays
 * in the day it started and a park far from London isn't split at UTC
 * midnight. Queue day files, D1 day reads, the archive and the uptime rollup
 * all key by it. Times inside a day keep one encoding: minutes since
 * `${date}T00:00:00Z`, which runs negative east of UTC and past 1440 west of
 * it. Mirrored in frontend/src/parkDay.ts.
 */
export const DAY_ROLLOVER_HOUR = 4;

/** Exact UTC offset of `timeZone` at instant `ms`, in minutes (BST → 60). */
export function tzOffsetAt(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The instant of local wall-clock `hour`:00 on `date` in `timeZone`. Two
 *  passes, so a guess on the far side of a DST change corrects itself. */
export function localInstant(date: string, hour: number, timeZone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000;
  const first = wall - tzOffsetAt(wall, timeZone) * 60_000;
  return wall - tzOffsetAt(first, timeZone) * 60_000;
}

const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The park day an instant belongs to. */
export function parkDay(ms: number, timeZone: string): string {
  const local = ms + tzOffsetAt(ms, timeZone) * 60_000 - DAY_ROLLOVER_HOUR * 3_600_000;
  return new Date(local).toISOString().slice(0, 10);
}

/** A park day as a half-open range of instants [start, end). 23 or 25 hours
 *  long on a DST change day. */
export function parkDayBounds(date: string, timeZone: string): { start: number; end: number } {
  return {
    start: localInstant(date, DAY_ROLLOVER_HOUR, timeZone),
    end: localInstant(addDays(date, 1), DAY_ROLLOVER_HOUR, timeZone),
  };
}

/** UTC offset in minutes for a zone on a date (Paris: 60 in winter, 120 in summer). */
export function tzOffsetMin(date: string, timeZone: string): number {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(
      new Date(`${date}T12:00:00Z`),
    ),
  );
  return (h - 12) * 60;
}

/** Disneyland Paris's GraphQL API: unauthenticated, wants `x-application-id`. */
const DLP_GRAPHQL = "https://api.disneylandparis.com/query";

/** The resort-wide wait feed both Disneyland Paris parks read. */
const DLP_QUEUE = {
  waitTimesUrl: "https://dlp-wt.wdprapps.disney.com/prod/v1/waitTimes",
  apiKey: "",
  graphqlUrl: DLP_GRAPHQL,
};

/** Drayton Manor's TE2 app identifiers, from its Hermes bundle
 *  (`draytonManorConfig`, prod). The client secret is filled in from APP_KEYS
 *  (src/app-keys.ts). */
const DRAYTON_TE2: Te2Config = {
  apiUrl: "https://api.us.te2.io",
  tokenUrl: "https://api.us.te2.io/global-auth/oauth2/token",
  clientId: "ngap_dmr_prod",
  clientSecret: "",
  venueId: "DMR_BG",
  customerId: "dmr",
};

/** Build a park's opening-hours calendar URL for the given location ids. */
const hoursUrl = (host: string, locationIds: string) =>
  `https://www.${host}/api/openinghours/getcalendar?lang=en-GB&locationIds=${locationIds}`;

export const PARKS: ParkConfig[] = [
  {
    key: "alton_towers",
    weather: { lat: 52.987, lon: -1.889 },
    label: "Alton Towers",
    merchantId: "800",
    origin: "https://me-twalton.tickets.altontowers.com",
    bootstrapSlug: "ME-TWALTON",
    merlinPass: true,
    // 805, not 807: 807 is a Fastrack-only catalog with no partner packages.
    exchange: {
      merchantIds: ["805"],
      origin: "https://me-twalton.tickets.altontowers.com",
      bootstrapSlug: "ME-TWALTON-EXCHANGE",
    },
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("altontowers.com", "2047,2609,2613"),
      locations: [
        { id: "2047", kind: "themepark" },
        { id: "2609", kind: "waterpark" },
        { id: "2613", kind: "golf" },
      ],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "alton-towers-resort",
    },
    products: [
      {
        // Main park tickets — event 2502. Package ids (incl. seasonal/offer
        // variants that cover the Scarefest dates) are rediscovered from the
        // catalog; the server merges them into one entry per date.
        key: "main",
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2502" },
      },
      {
        // Ride Access Pass — customer_type 14036, event 2531. Hard pool
        // (available + used == capacity); capacity grows as batches release.
        key: "rap",
        extra_movie: "date",
        include_times: true,
        P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2531", id: "25906" }],
      },
    ],
  },
  {
    key: "thorpe_park",
    weather: { lat: 51.404, lon: -0.514 },
    label: "Thorpe Park",
    merchantId: "105",
    origin: "https://me-tpr.tickets.thorpepark.com",
    bootstrapSlug: "ME-TPR",
    merlinPass: true,
    exchange: {
      merchantIds: ["107"],
      origin: "https://me-tpchertsey-exchange.secure-cdn.meg-eu.accessoticketing.com",
      bootstrapSlug: "ME-TPCHERTSEY-EXCHANGE",
    },
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("thorpepark.com", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "thorpe-park",
    },
    products: [
      {
        key: "rap",
        extra_movie: "date",
        include_times: true,
        P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2658", id: "77728" }],
      },
      {
        // STEALTH: 20 YEARS OF SPEED — a one-night event on 2026-09-28, 6-8pm
        // ride time on Stealth plus the sale of 205 numbered pieces of its
        // retired launch cable. £10pp, entry from 5pm.
        //
        // PROMO-GATED, so it is NOT in the bootstrap catalog and discovery
        // cannot find it: the package only surfaces via GetMerchantPackageList
        // with `promo_codes: "Stealth20"` (see docs/accesso-api.md). Worse, the
        // code was never published on thorpepark.com at all — it arrived in a
        // Facebook ad — so even crawling the park's own pages wouldn't turn it
        // up. Hence a hardcoded P, like RAP.
        //
        // Availability itself needs no promo code: event 2064 + package 56991 +
        // CT 231 answers GetMerchantPackageEventDates directly.
        key: "stealth20",
        label: "Stealth 20",
        extra_movie: "",
        include_times: false,
        P: [{ CT: [{ id: "231", qty: 1 }], event_id: "2064", id: "56991" }],
        until: "2026-09-28",
      },
      {
        // Main tickets — event 2507. Package ids rediscovered from the
        // catalog. Thorpe is the park where the offer packages' ring-fenced
        // 3,000-seat sub-allocation bites (see DiscoverSpec.name), so only the
        // exactly-named "1 Day Ticket" packages + the prebook anchor are sent,
        // plus "Fright Nights Entry" — the season's own public day ticket, on
        // the same pool (see DiscoverSpec.alsoNames).
        key: "main",
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2507", alsoNames: ["Fright Nights Entry"] },
      },
    ],
  },
  {
    key: "legoland",
    weather: { lat: 51.464, lon: -0.650 },
    label: "Legoland Windsor",
    merchantId: "700",
    origin: "https://me-llwindsor.tickets.legoland.co.uk",
    bootstrapSlug: "ME-LLWINDSOR",
    merlinPass: true,
    // Split across two ids: the John Lewis days sit on 700, Blue Light on 704.
    exchange: {
      merchantIds: ["700", "704"],
      origin: "https://me-llwindsor.tickets.legoland.co.uk",
      bootstrapSlug: "ME-LLWINDSOR-EXCHANGE",
    },
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("legoland.co.uk", "1716,7236"),
      locations: [
        { id: "1716", kind: "themepark" },
        { id: "7236", kind: "golf" },
      ],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-windsor",
    },
    products: [
      {
        key: "rap",
        extra_movie: "date",
        include_times: true,
        P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2659", id: "90339" }],
      },
      {
        // Main tickets — event 2399. Package ids rediscovered from the
        // catalog. Legoland's standard dated day ticket is named "Online
        // Saver", not "1 Day Ticket".
        key: "main",
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2399", name: "Online Saver" },
      },
    ],
  },
  {
    key: "chessington",
    weather: { lat: 51.348, lon: -0.317 },
    label: "Chessington",
    merchantId: "6400",
    origin: "https://me-wachessington.tickets.chessington.com",
    bootstrapSlug: "ME-WACHESSINGTON",
    merlinPass: true,
    exchange: {
      merchantIds: ["6407"],
      origin: "https://me-wachessington.tickets.chessington.com",
      bootstrapSlug: "ME-WACHESSINGTON-EXCHANGE",
    },
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("chessington.com", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "chessington",
    },
    products: [
      {
        key: "rap",
        extra_movie: "date",
        include_times: true,
        P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2654", id: "90810" }],
      },
      {
        // Main tickets — event 2506. Package ids rediscovered from the
        // catalog. Park closes for winter.
        key: "main",
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2506" },
      },
      {
        // Christmas sells as "Theme Park Entry Only" on the SAME event as the
        // day ticket, and cannot be folded into `main` the way Thorpe's Fright
        // Nights can: Chessington's "1 Day Ticket" returns those dates with
        // capacity 0, and the accesso merge takes the most constrained
        // allocation (docs §3.1), so the zero wins and the date reads as 0/0.
        // Queried alone it reports the full 11,440 pool. Hence its own product.
        // The daily season-name job detects exactly this case and records it as
        // rejected rather than adopting it (see special-days.ts).
        key: "season",
        label: "Christmas",
        extra_movie: "",
        include_times: false,
        // A STATIC P, like RAP, not discovery. Two packages carry this exact
        // name on event 2506: 99211 reports the season properly (2026-11-21:
        // 11,440 / 11,332) and 99241 returns no dates at all, but sending both
        // re-triggers the very merge this product exists to escape and zeroes
        // every date. Discovery has no way to tell them apart without probing.
        // Package ids rotate seasonally, so this needs the same hand-maintenance
        // RAP does — and when it goes stale the Christmas dates reappear in the
        // anomaly report as open_no_tickets, which is how it will be noticed.
        P: [{ CT: [{ id: "249", qty: 1 }], event_id: "2506", id: "99211" }],
      },
    ],
  },
  {
    // Paulton's Park (home of Peppa Pig World) — INDEPENDENT, not Merlin. No
    // accesso backend, but (like Blackpool) it's a full calendar + queue park:
    //  - Hours + events: two plain JSON blobs on its own site (`kind:"paultons"`)
    //    — a structured `times` array and a date-range `special-events` array.
    //    These also frame the queue sparkline's opening-window x-axis.
    //  - Availability: a static `tickets/availability.json` (per-day capacity /
    //    remaining) drives the "main" heatmap via `availabilityUrl` — not accesso.
    //  - Queues: First Option Software's custom backend (the `x-token` is the
    //    app-embedded static token). Names come inline with the feed, so unlike
    //    the Attractions.io parks there's no content bundle / catalog cron.
    key: "paultons",
    weather: { lat: 50.949, lon: -1.552 },
    label: "Paultons Park",
    openingHours: {
      kind: "paultons",
      timesUrl: "https://paultonspark.co.uk/info/opening-times/times.json",
      eventsUrl: "https://paultonspark.co.uk/info/opening-times/special-events.json",
      locationName: "Paultons Park",
    },
    queue: {
      kind: "fos",
      apiUrl: "https://paultonsapp.firstoptionsoftware.com",
      token: "",
    },
    products: [
      {
        // Day-ticket availability from Paulton's own JSON blob (not accesso, so
        // no P/discover). Same Snapshot model as the Merlin parks → same heatmap.
        key: "main",
        extra_movie: "",
        include_times: false,
        availabilityUrl: "https://paultonspark.co.uk/tickets/availability.json",
      },
    ],
  },
  {
    // Flamingo Land (North Yorkshire) — INDEPENDENT, not Merlin. A calendar +
    // queue park (like Blackpool): no accesso backend and no ticket products, but
    // it has both a live queue feed AND a What's-On calendar.
    //  - Queues: its Capacitor guest app reads live waits from a Firebase Cloud
    //    Firestore collection (`rides_data`), one doc per ride with `queue_time`
    //    (whole minutes) + `statusOpen`. Firestore reads need a Firebase ID token;
    //    the app enables anonymous auth, so we mint one anonymous user with the
    //    app-embedded web apiKey and reuse it (cached/refreshed in R2). Ride names
    //    are inline, so the catalog is synthesised inline during the queue poll (no
    //    content bundle / catalog cron). See docs/flamingoland-api.md.
    //  - Calendar: no opening-hours feed exists (the marketing site shows only a
    //    manually-edited "today" blurb, and Firestore has no calendar collection).
    //    Falling back to special events, it runs The Events Calendar (Tribe) plugin,
    //    whose public iCal feed we page through into a rolling What's-On calendar
    //    (headline act per day + full lineup). See docs/flamingoland-calendar.md.
    key: "flamingoland",
    weather: { lat: 54.209, lon: -0.808 },
    label: "Flamingo Land",
    openingHours: {
      kind: "flamingoland",
      icalUrl: "https://www.flamingoland.co.uk/holiday-resort/entertainment-guide/list/",
    },
    queue: {
      kind: "firestore",
      projectId: "flamingo-land-app",
      apiKey: "",
      collection: "rides_data",
    },
    products: [],
  },
  {
    // Blackpool Pleasure Beach — INDEPENDENT, not Merlin. A calendar + queue park
    // (the only independent one with both): no accesso ticket availability, but it
    // DOES have a marketing-site opening calendar we scrape, alongside live queues.
    //  - Queues: a bespoke Laravel API (`today.blackpoolpleasurebeach.com`) whose
    //    reads sit behind a per-USER Sanctum token — no static/app token, so we log
    //    in with a dedicated account (BPB_EMAIL/BPB_PASSWORD secrets) and cache the
    //    token in R2. Ride names + thrill category are inline, so like the other
    //    independents there's no content bundle / catalog cron.
    //  - Hours: the park exposes its whole forward calendar as a JSON API
    //    (park-dates-times/v2) — one entry per open date, no auth or header gotchas.
    // See docs/blackpool-api.md.
    key: "blackpool",
    weather: { lat: 53.791, lon: -3.056 },
    label: "Blackpool Pleasure Beach",
    openingHours: {
      kind: "bpb",
      apiUrl: "https://bookings.blackpoolpleasurebeach.com/api/park-dates-times/v2",
      locationName: "Pleasure Beach Resort",
    },
    queue: {
      kind: "bpb",
      apiUrl: "https://today.blackpoolpleasurebeach.com",
    },
    products: [],
  },
  {
    // Disneyland Paris, the resort's first park. A calendar + queue park like
    // Blackpool, and the only one outside the UK, so its times are Paris time.
    //  - Queues: the app's wait feed (static `x-api-key` from the Hermes bundle),
    //    shared with Disney Adventure World and filtered by `parkId`. Names, lands
    //    and heights come from the public GraphQL API, cached in R2 for a day.
    //  - Hours: the same GraphQL API, every published date in one aliased query.
    // See docs/disneylandparis-api.md.
    key: "disneyland_park",
    weather: { lat: 48.873, lon: 2.776 },
    label: "Disneyland Park",
    timeZone: "Europe/Paris",
    openingHours: {
      kind: "dlp",
      graphqlUrl: DLP_GRAPHQL,
      parkId: "P1",
      locationName: "Disneyland Park",
    },
    queue: { kind: "dlp", ...DLP_QUEUE, parkId: "P1" },
    products: [],
  },
  {
    // Disneyland Paris's second park, formerly Walt Disney Studios. Same feeds
    // as Disneyland Park above, filtered to P2.
    key: "disney_adventure_world",
    weather: { lat: 48.866, lon: 2.777 },
    label: "Disney Adventure World",
    timeZone: "Europe/Paris",
    openingHours: {
      kind: "dlp",
      graphqlUrl: DLP_GRAPHQL,
      parkId: "P2",
      locationName: "Disney Adventure World",
    },
    queue: { kind: "dlp", ...DLP_QUEUE, parkId: "P2" },
    products: [],
  },  // Merlin's European parks: Attractions.io queues and the same marketing-site
  // opening-hours API as the UK parks (location 1716 is the theme park on each).
  // No accesso ticket tracking and not on the UK Merlin Annual Pass. Keys from
  // each app's BuildConfig API_KEY (docs/apk-download.md).
  {
    key: "legoland_billund",
    weather: { lat: 55.735, lon: 9.126 },
    label: "Legoland Billund",
    timeZone: "Europe/Copenhagen",
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("legoland.dk", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-billund",
    },
    products: [],
  },
  {
    key: "legoland_deutschland",
    weather: { lat: 48.424, lon: 10.302 },
    label: "Legoland Deutschland",
    timeZone: "Europe/Berlin",
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("legoland.de", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-deutschland",
    },
    products: [],
  },
  {
    key: "gardaland",
    weather: { lat: 45.457, lon: 10.711 },
    label: "Gardaland",
    timeZone: "Europe/Rome",
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("gardaland.it", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "gardaland",
    },
    products: [],
  },
  {
    key: "heide_park",
    weather: { lat: 53.024, lon: 9.879 },
    label: "Heide Park",
    timeZone: "Europe/Berlin",
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("heide-park.de", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "heide-park",
    },
    products: [],
  },
  // Merlin's parks in Asia and the US, then Knoebels (independent, US). Same
  // Attractions.io queues; hours from each Merlin site's getcalendar API, whose
  // US parks sit under a path prefix (/florida). Location ids are the page's
  // `window.locationIds`; 1716 is the theme park except at New York (3147) and
  // Korea (11321). Japan and Korea need lang=en-US (en-GB returns nothing).
  {
    key: "legoland_japan",
    weather: { lat: 35.050, lon: 136.844 },
    label: "Legoland Japan",
    timeZone: "Asia/Tokyo",
    openingHours: {
      kind: "accesso",
      calendarUrl: "https://www.legoland.jp/api/openinghours/getcalendar?lang=en-US&locationIds=1716",
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-japan",
    },
    products: [],
  },
  {
    key: "legoland_korea",
    weather: { lat: 37.885, lon: 127.697 },
    label: "Legoland Korea",
    timeZone: "Asia/Seoul",
    openingHours: {
      kind: "accesso",
      calendarUrl: "https://www.legoland.kr/api/openinghours/getcalendar?lang=en-US&locationIds=11321",
      locations: [{ id: "11321", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-korea",
    },
    products: [],
  },
  {
    key: "legoland_florida",
    weather: { lat: 27.991, lon: -81.691 },
    label: "Legoland Florida",
    timeZone: "America/New_York",
    openingHours: {
      kind: "accesso",
      calendarUrl: "https://www.legoland.com/florida/api/openinghours/getcalendar?lang=en-US&locationIds=1716,1718",
      locations: [{ id: "1716", kind: "themepark" }, { id: "1718", kind: "waterpark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-florida",
    },
    products: [],
  },
  {
    key: "peppa_pig_florida",
    weather: { lat: 27.987, lon: -81.689 },
    label: "Peppa Pig Theme Park",
    timeZone: "America/New_York",
    openingHours: {
      kind: "accesso",
      calendarUrl: "https://www.peppapigthemepark.com/florida/api/openinghours/getcalendar?lang=en-US&locationIds=1716",
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "peppa-pig-theme-park",
    },
    products: [],
  },
  {
    key: "legoland_california",
    weather: { lat: 33.128, lon: -117.312 },
    label: "Legoland California",
    timeZone: "America/Los_Angeles",
    openingHours: {
      kind: "accesso",
      calendarUrl: "https://www.legoland.com/california/api/openinghours/getcalendar?lang=en-US&locationIds=1716,1719",
      locations: [{ id: "1716", kind: "themepark" }, { id: "1719", kind: "waterpark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-california",
    },
    products: [],
  },
  {
    key: "legoland_new_york",
    weather: { lat: 41.380, lon: -74.313 },
    label: "Legoland New York",
    timeZone: "America/New_York",
    openingHours: {
      kind: "accesso",
      calendarUrl: "https://www.legoland.com/new-york/api/openinghours/getcalendar?lang=en-US&locationIds=3147",
      locations: [{ id: "3147", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "legoland-new-york",
    },
    products: [],
  },
  {
    key: "knoebels",
    weather: { lat: 40.879, lon: -76.504 },
    label: "Knoebels",
    timeZone: "America/New_York",
    openingHours: {
      kind: "knoebels",
      hoursUrl: "https://knoebels.com/wp-json/knoebels/v1/hours",
      timeZone: "America/New_York",
      windowDays: 31,
      locationName: "Knoebels",
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "knoebels-amusement-park",
    },
    products: [],
  },
  // Pleasurewood Hills (Looping Group, Lowestoft): Attractions.io queues; hours
  // from the opening-times page's inline arrays. Key from the app's BuildConfig.
  {
    key: "pleasurewood_hills",
    weather: { lat: 52.507, lon: 1.745 },
    label: "Pleasurewood Hills",
    openingHours: {
      kind: "pleasurewood",
      pageUrl: "https://pleasurewoodhills.com/park-info/opening-times/",
      locationName: "Pleasurewood Hills",
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "pleasurewood-hills",
    },
    products: [],
  },
  // Crealy Theme Park (independent, Exeter): Attractions.io queues, though the
  // app lists only one queue line (The Twister) as of 2026-10; hours from the
  // site's Umbraco month calendar.
  {
    key: "crealy",
    weather: { lat: 50.705, lon: -3.416 },
    label: "Crealy Theme Park",
    openingHours: {
      kind: "crealy",
      monthUrl: "https://www.crealy.co.uk/umbraco/surface/OpeningTimesCalendar/RenderMonth",
      attractionId: "1849",
      homePageId: "1824",
      months: 6,
      locationName: "Crealy Theme Park",
    },
    queue: {
      kind: "attractions",
      apiKey: "",
      slug: "crealy-theme-park-resort",
    },
    products: [],
  },
  // Drayton Manor (independent, Staffordshire; Looping Group). Its app runs on
  // accesso's TE2 platform, which serves both the live ride status and the
  // opening calendar behind one anonymous token. Its Attractions.io bundle
  // (`drayton-manor`) stopped updating in February 2022. Tickets are accesso
  // too, but on its own stack (see docs/accesso-api.md, Drayton Manor).
  {
    key: "drayton_manor",
    weather: { lat: 52.612, lon: -1.714 },
    label: "Drayton Manor",
    merchantId: "100",
    origin: "https://lg-draytonmanor.tickets.draytonmanor.co.uk",
    bootstrapSlug: "LG-DRAYTONMANOR",
    accessoApi: "https://ecomm.api.eu.accessoticketing.com",
    accessoClient: "accesso304",
    openingHours: {
      kind: "te2",
      ...DRAYTON_TE2,
      locationName: "Drayton Manor",
      webCalendarUrl: "https://www.draytonmanor.co.uk/calendar",
    },
    queue: { kind: "te2", ...DRAYTON_TE2 },
    products: [
      {
        // Event 2 is the one park pool (10,000 a day, 6,000 on Blazing
        // Halloween days). No single package covers the season: the day ticket
        // sells only today and each season sells its own dates, so match every
        // package the booking site's "Tickets" keyword lists. All report the
        // same pool, so the merge loses nothing.
        key: "main",
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2", keyword: "Tickets", anchorClassMatch: "" },
      },
    ],
  },
];

/** Every (park, product) pair, flattened — used to force a full manual poll. */
export function allProducts(): { park: ParkConfig; product: ProductConfig }[] {
  return PARKS.flatMap((park) => park.products.map((product) => ({ park, product })));
}

/** Parks with a live queue-time source (any kind). Narrowed so `park.queue` is
 *  non-optional at the call site. */
export function queueParks(): (ParkConfig & { queue: QueueSource })[] {
  return PARKS.filter((p): p is ParkConfig & { queue: QueueSource } => !!p.queue);
}

/** Queue parks whose ride catalog is built from an Attractions.io content
 *  bundle (the CPU-heavy daily unzip). Excludes the inline-name backends (`fos`
 *  Paulton's, `firestore` Flamingo Land), whose ride names arrive with the live
 *  feed — no bundle, no catalog cron. */
export function attractionsParks(): (ParkConfig & {
  queue: { kind: "attractions" } & AttractionsConfig;
})[] {
  return PARKS.filter(
    (p): p is ParkConfig & { queue: { kind: "attractions" } & AttractionsConfig } =>
      p.queue?.kind === "attractions",
  );
}

/** Queue parks on the First Option backend (Paulton's). Their rider restrictions
 *  aren't in the feed — they're scraped daily from the park website off the hot
 *  path (see paultons-restrictions.ts). */
export function fosParks(): (ParkConfig & {
  queue: { kind: "fos" } & FirstOptionConfig;
})[] {
  return PARKS.filter(
    (p): p is ParkConfig & { queue: { kind: "fos" } & FirstOptionConfig } =>
      p.queue?.kind === "fos",
  );
}
