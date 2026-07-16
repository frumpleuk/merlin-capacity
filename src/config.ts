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

export const HORIZON_DAYS = 150;

export interface ProductConfig {
  key: string; // matches the R2 file: calendar/<park>/<key>.json
  /** Poll at most once every N minutes. RAP releases vanish fast → 1; main
   *  and slow-moving products can be less frequent to save writes/requests. */
  intervalMinutes: number;
  extra_movie: string;
  include_times: boolean;
  P: unknown[]; // package/customer-type selectors sent to the API
}

export interface ParkConfig {
  key: string;
  merchantId: string;
  origin: string;
  products: ProductConfig[];
}

export const PARKS: ParkConfig[] = [
  {
    key: "alton_towers",
    merchantId: "800",
    origin: "https://me-twalton.tickets.altontowers.com",
    products: [
      {
        // Main park tickets — customer_type 14143. Server merges the price
        // bands into one entry per date, so we send the full known set.
        key: "main",
        intervalMinutes: 5,
        extra_movie: "",
        include_times: false,
        P: [
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "96905" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "96906" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "96907" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "96908" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "112896" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "112897" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "112898" },
          { CT: [{ id: "14143", qty: 1 }], event_id: "2502", id: "112899" },
        ],
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
