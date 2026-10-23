// The nav is driven entirely by this catalog. Adding a park, a product, or a
// special event is a one-line change here — the backend poller must also cover
// it, otherwise the page renders "no data yet".

export interface ProductDef {
  key: string; // matches the R2 file: calendar/<park>/<key>.json
  label: string;
}

export interface ParkDef {
  /** Internal id: R2 paths, the poller, menus. Never shown in a URL. */
  key: string;
  /** The park's name in its URL, /<country>/<slug>. Set by hand, not derived
   *  from the label, so renaming a park doesn't break links to it. */
  slug: string;
  label: string;
  products: ProductDef[];
  /** Queue-only park (Paulton's): no accesso tickets/calendar, only the live
   *  ride-queue times. The nav shows just the Queues tab and lands there. */
  queueOnly?: boolean;
  /** No Queues or Uptime tabs: the park's feed posts no wait times (Drayton
   *  Manor's new app, 2026-10). The worker still polls it, so history starts
   *  the day waits appear. */
  noQueues?: boolean;
  /** One-off ticketed events with their own allocation, shown as extra lines on
   *  the Calendar tab. Deliberately NOT in `products`: those drive the nav, and
   *  a single night doesn't deserve a tab that goes dead the morning after. */
  events?: ProductDef[];
  /** On the Merlin Annual Pass, so the estate-wide entry restrictions apply and
   *  the calendar shows which pass levels are refused on a date (see
   *  loadRestrictions). The independents are on their own pass schemes. */
  merlinPass?: boolean;
  /** IANA zone the park's clock times are shown in. Default Europe/London.
   *  Mirrors `timeZone` in src/config.ts. */
  timeZone?: string;
  /** ISO 3166-1 alpha-2 code; the park picker groups by it and spells it out
   *  with Intl.DisplayNames. */
  country: string;
  /** Who runs it, for the picker's "by operator" grouping. Unset is an
   *  independent park. */
  operator?: string;
  /** The resort, when it holds more than one park we list (Disneyland Paris).
   *  The picker nests the resort's parks under this name. */
  resort?: string;
}

// Only list products the poller actually captures. Main tickets for the
// non-Alton parks need fresh package ids (their 2025 ids return FAILED), so
// they're RAP-only until those are captured — see src/config.ts.
export const PARKS: ParkDef[] = [
  {
    key: "alton_towers",
    slug: "alton-towers",
    country: "GB",
    operator: "Merlin Entertainments",
    merlinPass: true,
    label: "Alton Towers",
    products: [
      { key: "main", label: "Tickets" },
      { key: "rap", label: "RAP" },
      // Special events (Scarefest, Fireworks, …) slot in here once the poller
      // captures them, e.g. { key: "scarefest", label: "Scarefest" }.
    ],
  },
  {
    key: "thorpe_park",
    slug: "thorpe-park",
    country: "GB",
    operator: "Merlin Entertainments",
    merlinPass: true,
    label: "Thorpe Park",
    products: [
      { key: "main", label: "Tickets" },
      { key: "rap", label: "RAP" },
    ],
    // 28 Sep 2026 only — see the stealth20 product in src/config.ts.
    events: [{ key: "stealth20", label: "Stealth 20" }],
  },
  {
    key: "legoland",
    slug: "legoland-windsor",
    country: "GB",
    operator: "Merlin Entertainments",
    merlinPass: true,
    label: "Legoland Windsor",
    products: [
      { key: "main", label: "Tickets" },
      { key: "rap", label: "RAP" },
    ],
  },
  {
    key: "chessington",
    slug: "chessington",
    country: "GB",
    operator: "Merlin Entertainments",
    merlinPass: true,
    label: "Chessington",
    products: [
      { key: "main", label: "Tickets" },
      { key: "rap", label: "RAP" },
    ],
  },
  {
    // Independent park (Peppa Pig World) — a calendar + queue park (like
    // Blackpool), not queueOnly. No accesso backend, but it publishes its own
    // JSON: an opening-hours calendar (times + special events) AND day-ticket
    // availability (the "main" heatmap). The calendar's opening times frame the
    // queue sparkline's x-axis.
    key: "paultons",
    slug: "paultons-park",
    country: "GB",
    label: "Paultons Park",
    products: [{ key: "main", label: "Tickets" }],
  },
  {
    // Independent park (North Yorkshire) — a calendar + queue park like Blackpool,
    // not queueOnly: no accesso tickets, but a What's-On calendar (special events
    // from The Events Calendar iCal feed — no opening hours) shows alongside live
    // queues.
    key: "flamingoland",
    slug: "flamingo-land",
    country: "GB",
    label: "Flamingo Land",
    products: [],
  },
  {
    // Independent park (Blackpool) — a calendar + queue park, not queueOnly: no
    // accesso ticket availability, but it DOES have an opening-hours calendar
    // (scraped from the marketing site) alongside live queues. So `products` is
    // empty (no availability heatmaps) but the Calendar tab still shows — hours
    // and events only.
    key: "blackpool",
    slug: "blackpool-pleasure-beach",
    country: "GB",
    label: "Blackpool Pleasure Beach",
    products: [],
  },
  {
    // Disneyland Paris's two parks, a calendar + queue park each. They share one
    // wait feed and one hours query, split by park id in the poller. Paris time.
    key: "disneyland_park",
    slug: "disneyland-park",
    country: "FR",
    operator: "Disney",
    resort: "Disneyland Paris",
    label: "Disneyland Park",
    products: [],
    timeZone: "Europe/Paris",
  },
  {
    key: "disney_adventure_world",
    slug: "disney-adventure-world",
    country: "FR",
    operator: "Disney",
    resort: "Disneyland Paris",
    label: "Disney Adventure World",
    products: [],
    timeZone: "Europe/Paris",
  },
  {
    key: "legoland_billund",
    slug: "legoland-billund",
    country: "DK",
    operator: "Merlin Entertainments",
    label: "Legoland Billund",
    products: [],
    timeZone: "Europe/Copenhagen",
  },
  {
    key: "legoland_deutschland",
    slug: "legoland-deutschland",
    country: "DE",
    operator: "Merlin Entertainments",
    label: "Legoland Deutschland",
    products: [],
    timeZone: "Europe/Berlin",
  },
  {
    key: "gardaland",
    slug: "gardaland",
    country: "IT",
    operator: "Merlin Entertainments",
    label: "Gardaland",
    products: [],
    timeZone: "Europe/Rome",
  },
  {
    key: "heide_park",
    slug: "heide-park",
    country: "DE",
    operator: "Merlin Entertainments",
    label: "Heide Park",
    products: [],
    timeZone: "Europe/Berlin",
  },
  {
    key: "legoland_japan",
    slug: "legoland-japan",
    country: "JP",
    operator: "Merlin Entertainments",
    label: "Legoland Japan",
    products: [],
    timeZone: "Asia/Tokyo",
  },
  {
    key: "legoland_korea",
    slug: "legoland-korea",
    country: "KR",
    operator: "Merlin Entertainments",
    label: "Legoland Korea",
    products: [],
    timeZone: "Asia/Seoul",
  },
  {
    key: "legoland_florida",
    slug: "legoland-florida",
    country: "US",
    operator: "Merlin Entertainments",
    resort: "Legoland Florida Resort",
    label: "Legoland Florida",
    products: [],
    timeZone: "America/New_York",
  },
  {
    key: "peppa_pig_florida",
    slug: "peppa-pig-theme-park",
    country: "US",
    operator: "Merlin Entertainments",
    resort: "Legoland Florida Resort",
    label: "Peppa Pig Theme Park",
    products: [],
    timeZone: "America/New_York",
  },
  {
    key: "legoland_california",
    slug: "legoland-california",
    country: "US",
    operator: "Merlin Entertainments",
    label: "Legoland California",
    products: [],
    timeZone: "America/Los_Angeles",
  },
  {
    key: "legoland_new_york",
    slug: "legoland-new-york",
    country: "US",
    operator: "Merlin Entertainments",
    label: "Legoland New York",
    products: [],
    timeZone: "America/New_York",
  },
  {
    key: "knoebels",
    slug: "knoebels",
    country: "US",
    label: "Knoebels",
    products: [],
    timeZone: "America/New_York",
  },
  {
    key: "pleasurewood_hills",
    slug: "pleasurewood-hills",
    country: "GB",
    operator: "Looping Group",
    label: "Pleasurewood Hills",
    products: [],
  },
  {
    key: "crealy",
    slug: "crealy",
    country: "GB",
    label: "Crealy Theme Park",
    products: [],
  },
  {
    key: "drayton_manor",
    slug: "drayton-manor",
    country: "GB",
    operator: "Looping Group",
    label: "Drayton Manor",
    products: [{ key: "main", label: "Tickets" }],
    noQueues: true,
  },
  {
    key: "tulleys",
    slug: "tulleys-shocktober-fest",
    country: "GB",
    label: "Tulleys Shocktober Fest",
    products: [],
  },
  {
    // At Twinlakes Park, Melton Mowbray.
    key: "xtreme_scream_park",
    slug: "xtreme-scream-park",
    country: "GB",
    label: "Xtreme Scream Park",
    products: [],
  },
];

/** A park's base URL: lower-case country code, then its slug (/gb/alton-towers). */
export function parkPath(p: ParkDef): string {
  return `/${p.country.toLowerCase()}/${p.slug}`;
}

// The rich per-park calendar (park home) is the default landing view.
export const PARK_HOME = parkPath(PARKS[0]);
// A specific product's heatmap — the drill-down default.
export const DEFAULT_PATH = `${PARK_HOME}/${PARKS[0].products[0].key}`;

/** By internal key. */
export function findPark(park: string | undefined): ParkDef | undefined {
  return PARKS.find((p) => p.key === park);
}

/** By the /:country/:slug URL segments. */
export function findParkByPath(
  country: string | undefined,
  slug: string | undefined,
): ParkDef | undefined {
  return PARKS.find(
    (p) => p.country.toLowerCase() === country?.toLowerCase() && p.slug === slug,
  );
}
