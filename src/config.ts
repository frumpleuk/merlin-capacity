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
export const HOST =
  "https://ecomm.api.meg-eu.accessoticketing.com/api/request/getmerchantpackageeventdates";

/** The public, unauthenticated catalog blob for a park (see docs/accesso-api.md).
 *  We derive main-ticket package ids from this instead of hardcoding them. */
export const bootstrapUrl = (slug: string) =>
  `https://ecomm.api.meg-eu.accessoticketing.com/static-api/bootstrap?m=${slug}&l=en-gb`;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// Fetch a full year ahead. The API only returns dates that are actually on
// sale (currently ~5–6 months out), so this doesn't inflate responses — it just
// stops us truncating what IS on sale (e.g. Legoland into late December) and
// auto-captures next year's dates as each park releases them.
export const HORIZON_DAYS = 365;


/** Attractions.io ("Occasio") identity for a park — powers ride names + live
 *  queue times (see docs/attractions-io-api.md). `apiKey` is the app's public
 *  per-park UUID (live-feed filename + Authorization); `slug` is the content
 *  bundle path segment. Both are app-embedded client identifiers, not secrets. */
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
  | ({ kind: "bpb" } & BpbConfig);

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
 *    headline). See docs/flamingoland-calendar.md. */
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
    };

/** How to find a product's packages in the bootstrap catalog, in place of a
 *  hardcoded `P`. `event_id` is stable per park; only the package ids rotate,
 *  and this rediscovers them. Defaults match a standard day ticket. */
export interface DiscoverSpec {
  event_id: string;
  packageClass?: string; // default "Daily Tickets"
  /** Case-insensitive SUBSTRING of the package `name`. Matches "1 Day Ticket"
   *  AND its seasonal/offer variants ("1 Day Ticket - 10% Offer", etc.) — those
   *  variants are what cover autumn/Halloween operating days (Thorpe Fright
   *  Nights, Alton Scarefest), so an exact match would miss them.
   *  Default "1 Day Ticket" (Legoland's dated day ticket is "Online Saver"). */
  name?: string;
  /** Also include packages whose class contains this (case-insensitive) as a
   *  "yield anchor". On dates the public day ticket isn't on sale yet — the whole
   *  autumn Fright Nights / Scarefest run, months ahead — annual-pass PREBOOK
   *  packages still are, and report the same event capacity/availability, so the
   *  date shows a figure instead of a gap. Matches "Prebook" and Alton's "AP
   *  Prebook"; on normal dates it doesn't change the numbers. "" disables. */
  anchorClassMatch?: string; // default "prebook"
}

export interface ProductConfig {
  key: string; // matches the R2 file: calendar/<park>/<key>.json
  extra_movie: string;
  include_times: boolean;
  /** Static package/customer-type selectors sent to the API. Used for products
   *  the catalog doesn't list (RAP). Exactly one of `P` / `discover` is set. */
  P?: unknown[];
  /** Or: rediscover the selectors from the catalog each TTL (main tickets). */
  discover?: DiscoverSpec;
  /** Independent (non-accesso) availability source: a static JSON blob of
   *  per-day capacity/availability (Paulton's `tickets/availability.json`). When
   *  set, the poll fetches this instead of the accesso API — the accesso payload
   *  fields (`extra_movie`/`include_times`/`P`/`discover`) are unused. Everything
   *  downstream (D1 delta log, month files, heatmap) is reused unchanged. */
  availabilityUrl?: string;
}

export interface ParkConfig {
  key: string;
  /** accesso availability identity. Optional: a queue-only park (Paulton's) has
   *  no accesso backend at all. Only ever read for parks with ticket `products`,
   *  so a queue-only park simply omits them. */
  merchantId?: string;
  origin?: string;
  /** Bootstrap catalog slug (NOT the subdomain — e.g. Chessington is
   *  ME-WACHESSINGTON, not ME-CWOA). From the park's landing-page `bootstrap?m=`. */
  bootstrapSlug?: string;
  /** Opening-hours source (park marketing site). Separate from the accesso
   *  availability API — a different host, endpoint, and response shape. Absent
   *  for a queue-only park (no marketing-site calendar to poll). */
  openingHours?: OpeningHoursConfig;
  /** Live queue-time source (Attractions.io or First Option). Absent = the park
   *  isn't queue-tracked. Separate backend(s) from accesso availability. */
  queue?: QueueSource;
  /** accesso ticket products to poll. Empty for a queue-only park. */
  products: ProductConfig[];
}

/** Build a park's opening-hours calendar URL for the given location ids. */
const hoursUrl = (host: string, locationIds: string) =>
  `https://www.${host}/api/openinghours/getcalendar?lang=en-GB&locationIds=${locationIds}`;

export const PARKS: ParkConfig[] = [
  {
    key: "alton_towers",
    merchantId: "800",
    origin: "https://me-twalton.tickets.altontowers.com",
    bootstrapSlug: "ME-TWALTON",
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
      apiKey: "e6c2bbf8-da54-47a2-a5ed-8b7797137113",
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
    merchantId: "105",
    origin: "https://me-tpr.tickets.thorpepark.com",
    bootstrapSlug: "ME-TPR",
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("thorpepark.com", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "a070eedc-db3a-4c69-b55a-b79336ce723f",
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
        // Main tickets — event 2507. Package ids rediscovered from the
        // catalog; the name-substring match pulls in the offer variants that
        // cover Thorpe's autumn Fright Nights operating days (the plain
        // "1 Day Ticket" packages alone stop at ~1 Oct).
        key: "main",
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2507" },
      },
    ],
  },
  {
    key: "legoland",
    merchantId: "700",
    origin: "https://me-llwindsor.tickets.legoland.co.uk",
    bootstrapSlug: "ME-LLWINDSOR",
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
      apiKey: "7b56aa91-d4c6-4f8f-bac6-441a141a8e81",
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
    merchantId: "6400",
    origin: "https://me-cwoa.tickets.chessington.com",
    bootstrapSlug: "ME-WACHESSINGTON",
    openingHours: {
      kind: "accesso",
      calendarUrl: hoursUrl("chessington.com", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    queue: {
      kind: "attractions",
      apiKey: "307f27cd-2be1-4b43-aee8-7832cfadb85f",
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
    openingHours: {
      kind: "paultons",
      timesUrl: "https://paultonspark.co.uk/info/opening-times/times.json",
      eventsUrl: "https://paultonspark.co.uk/info/opening-times/special-events.json",
      locationName: "Paultons Park",
    },
    queue: {
      kind: "fos",
      apiUrl: "https://paultonsapp.firstoptionsoftware.com",
      token: "Nn2ibRudVbMVlAsp",
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
    openingHours: {
      kind: "flamingoland",
      icalUrl: "https://www.flamingoland.co.uk/holiday-resort/entertainment-guide/list/",
    },
    queue: {
      kind: "firestore",
      projectId: "flamingo-land-app",
      apiKey: "AIzaSyA2yrf4wI5a5oynBWu7ehjFzai-vtFr64Y",
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
