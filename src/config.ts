import type { Product } from "./types";

/**
 * Alton Towers. All availability now flows through the shared accesso backend
 * (central host below), keyed by merchant id — the old per-park hosts block
 * datacenter IPs, this one does not. `GetMerchantPackageEventDates` is a
 * stateless read: no cart/session tokens required.
 *
 * `event_id`/`id` (package) values rotate over time and eventually return
 * status:FAILED — refresh them from the live booking site when a product
 * stops returning data. Sending a superset of old+new package ids is fine;
 * the API uses whichever are valid per date.
 */
export const HOST =
  "https://ecomm.api.meg-eu.accessoticketing.com/api/request/getmerchantpackageeventdates";

export const HORIZON_DAYS = 150;
export const MAIN_INTERVAL_MS = 15 * 60 * 1000; // main tickets barely move

interface ProductCfg {
  P: unknown[];
  extra_movie: string;
  include_times: boolean;
}

export const ALTON = {
  park: "alton_towers",
  merchantId: "800",
  origin: "https://me-twalton.tickets.altontowers.com",
  products: {
    // Main park tickets — customer_type 14143. Server merges the price bands
    // into one entry per date, so we send the full known set of packages.
    main: {
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
    // Ride Access Pass — customer_type 14036, event 2531. Hard pool
    // (available + used == capacity); capacity grows as batches are released.
    rap: {
      extra_movie: "date",
      include_times: true,
      P: [{ CT: [{ id: "14036", qty: 1 }], event_id: "2531", id: "25906" }],
    },
  } satisfies Record<Product, ProductCfg>,
};
