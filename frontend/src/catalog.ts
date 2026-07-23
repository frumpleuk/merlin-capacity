// The nav is driven entirely by this catalog. Adding a park, a product, or a
// special event is a one-line change here — the backend poller must also cover
// it, otherwise the page renders "no data yet".

export interface ProductDef {
  key: string; // matches the R2 file: calendar/<park>/<key>.json
  label: string;
}

export interface ParkDef {
  key: string;
  label: string;
  products: ProductDef[];
  /** Queue-only park (Paulton's): no accesso tickets/calendar, only the live
   *  ride-queue times. The nav shows just the Queues tab and lands there. */
  queueOnly?: boolean;
}

// Only list products the poller actually captures. Main tickets for the
// non-Alton parks need fresh package ids (their 2025 ids return FAILED), so
// they're RAP-only until those are captured — see src/config.ts.
export const PARKS: ParkDef[] = [
  {
    key: "alton_towers",
    label: "Alton Towers",
    products: [
      { key: "main", label: "Main tickets" },
      { key: "rap", label: "RAP" },
      // Special events (Scarefest, Fireworks, …) slot in here once the poller
      // captures them, e.g. { key: "scarefest", label: "Scarefest" }.
    ],
  },
  {
    key: "thorpe_park",
    label: "Thorpe Park",
    products: [
      { key: "main", label: "Main tickets" },
      { key: "rap", label: "RAP" },
    ],
  },
  {
    key: "legoland",
    label: "Legoland Windsor",
    products: [
      { key: "main", label: "Main tickets" },
      { key: "rap", label: "RAP" },
    ],
  },
  {
    key: "chessington",
    label: "Chessington",
    products: [
      { key: "main", label: "Main tickets" },
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
    label: "Paultons Park",
    products: [{ key: "main", label: "Tickets" }],
  },
  {
    // Independent park (North Yorkshire) — a calendar + queue park like Blackpool,
    // not queueOnly: no accesso tickets, but a What's-On calendar (special events
    // from The Events Calendar iCal feed — no opening hours) shows alongside live
    // queues.
    key: "flamingoland",
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
    label: "Blackpool Pleasure Beach",
    products: [],
  },
];

// The rich per-park calendar (park home) is the default landing view.
export const PARK_HOME = `/${PARKS[0].key}`;
// A specific product's heatmap — the drill-down default.
export const DEFAULT_PATH = `/${PARKS[0].key}/${PARKS[0].products[0].key}`;

export function findPark(park: string | undefined): ParkDef | undefined {
  return PARKS.find((p) => p.key === park);
}
