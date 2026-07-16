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
}

// Only list products the poller actually captures. Main tickets for the
// non-Alton parks need fresh package ids (their 2025 ids return FAILED), so
// they're RAP-only until those are captured — see src/config.ts.
export const PARKS: ParkDef[] = [
  {
    key: "alton_towers",
    label: "Alton Towers",
    products: [
      { key: "rap", label: "RAP" },
      { key: "main", label: "Main tickets" },
      // Special events (Scarefest, Fireworks, …) slot in here once the poller
      // captures them, e.g. { key: "scarefest", label: "Scarefest" }.
    ],
  },
  {
    key: "thorpe_park",
    label: "Thorpe Park",
    products: [
      { key: "rap", label: "RAP" },
      { key: "main", label: "Main tickets" },
    ],
  },
  {
    key: "legoland",
    label: "Legoland Windsor",
    products: [
      { key: "rap", label: "RAP" },
      { key: "main", label: "Main tickets" },
    ],
  },
  {
    key: "chessington",
    label: "Chessington",
    products: [{ key: "rap", label: "RAP" }],
  },
];

export const DEFAULT_PATH = `/${PARKS[0].key}/${PARKS[0].products[0].key}`;

export function findPark(park: string | undefined): ParkDef | undefined {
  return PARKS.find((p) => p.key === park);
}
