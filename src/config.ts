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

/** How long a discovered package list is reused before re-deriving from the
 *  catalog. Package ids rotate at most seasonally, so twice a day is ample and
 *  keeps the 3 MB bootstrap fetch/parse well off the hot path. */
export const DISCOVERY_TTL_MS = 12 * 60 * 60 * 1000;

/** How often to refresh opening hours. They change rarely (the prototype
 *  scraped every 24h), so 6h keeps the served file fresh without churn. */
export const HOURS_INTERVAL_MINUTES = 360;

/** A location within a park's opening-hours calendar. `id` is accesso's
 *  locationId; `kind` drives the icon shown in the UI. */
export interface OpeningHoursLocation {
  id: string;
  kind: "themepark" | "waterpark" | "golf";
}

/** Where and how to read a park's opening hours. The marketing sites expose an
 *  unauthenticated `getcalendar` endpoint (needs a browser UA — a short UA
 *  403s). `lastEntryTime` on each day is overloaded: sometimes a genuine
 *  last-entry note, sometimes a special-event name — classified in hours.ts. */
export interface OpeningHoursConfig {
  calendarUrl: string;
  locations: OpeningHoursLocation[];
}

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
}

export interface ProductConfig {
  key: string; // matches the R2 file: calendar/<park>/<key>.json
  /** Poll at most once every N minutes. RAP releases vanish fast → 1; main
   *  and slow-moving products can be less frequent to save writes/requests. */
  intervalMinutes: number;
  extra_movie: string;
  include_times: boolean;
  /** Static package/customer-type selectors sent to the API. Used for products
   *  the catalog doesn't list (RAP). Exactly one of `P` / `discover` is set. */
  P?: unknown[];
  /** Or: rediscover the selectors from the catalog each TTL (main tickets). */
  discover?: DiscoverSpec;
}

export interface ParkConfig {
  key: string;
  merchantId: string;
  origin: string;
  /** Bootstrap catalog slug (NOT the subdomain — e.g. Chessington is
   *  ME-WACHESSINGTON, not ME-CWOA). From the park's landing-page `bootstrap?m=`. */
  bootstrapSlug: string;
  /** Opening-hours source (park marketing site). Separate from the accesso
   *  availability API — a different host, endpoint, and response shape. */
  openingHours: OpeningHoursConfig;
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
      calendarUrl: hoursUrl("altontowers.com", "2047,2609,2613"),
      locations: [
        { id: "2047", kind: "themepark" },
        { id: "2609", kind: "waterpark" },
        { id: "2613", kind: "golf" },
      ],
    },
    products: [
      {
        // Main park tickets — event 2502. Package ids (incl. seasonal/offer
        // variants that cover the Scarefest dates) are rediscovered from the
        // catalog; the server merges them into one entry per date.
        key: "main",
        intervalMinutes: 5,
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2502" },
      },
      {
        // Ride Access Pass — customer_type 14036, event 2531. Hard pool
        // (available + used == capacity); capacity grows as batches release.
        key: "rap",
        intervalMinutes: 1,
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
      calendarUrl: hoursUrl("thorpepark.com", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    products: [
      {
        key: "rap",
        intervalMinutes: 1,
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
        intervalMinutes: 5,
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
      calendarUrl: hoursUrl("legoland.co.uk", "1716,7236"),
      locations: [
        { id: "1716", kind: "themepark" },
        { id: "7236", kind: "golf" },
      ],
    },
    products: [
      {
        key: "rap",
        intervalMinutes: 1,
        extra_movie: "date",
        include_times: true,
        P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2659", id: "90339" }],
      },
      {
        // Main tickets — event 2399. Package ids rediscovered from the
        // catalog. Legoland's standard dated day ticket is named "Online
        // Saver", not "1 Day Ticket".
        key: "main",
        intervalMinutes: 5,
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
      calendarUrl: hoursUrl("chessington.com", "1716"),
      locations: [{ id: "1716", kind: "themepark" }],
    },
    products: [
      {
        key: "rap",
        intervalMinutes: 1,
        extra_movie: "date",
        include_times: true,
        P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2654", id: "90810" }],
      },
      {
        // Main tickets — event 2506. Package ids rediscovered from the
        // catalog. Park closes for winter.
        key: "main",
        intervalMinutes: 5,
        extra_movie: "",
        include_times: false,
        discover: { event_id: "2506" },
      },
    ],
  },
];

/** Every (park, product) pair, flattened — used to force a full manual poll. */
export function allProducts(): { park: ParkConfig; product: ProductConfig }[] {
  return PARKS.flatMap((park) => park.products.map((product) => ({ park, product })));
}

/** Pairs due to poll at the given epoch-minute (respecting each product's
 *  intervalMinutes). Stateless: derived purely from the cron's scheduled time. */
export function dueProducts(
  epochMinute: number,
): { park: ParkConfig; product: ProductConfig }[] {
  return allProducts().filter(
    ({ product }) => epochMinute % product.intervalMinutes === 0,
  );
}
