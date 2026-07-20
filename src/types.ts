export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Secret gating the manual /poll trigger. Set via `wrangler secret put
   *  POLL_KEY` (prod) or .dev.vars (local). If unset, /poll is denied. */
  POLL_KEY?: string;
}

/** A product key: 'main', 'rap', or a special-event key. */
export type Product = string;

/** One day's numbers for one product. */
export interface DayObs {
  capacity: number;
  available: number;
  used: number;
  packageIds: string;
  /** Was the public day ticket on general sale for this date? False when the
   *  date is open only via the prebook yield anchor (autumn dates not yet on
   *  public sale). Undefined for products with no anchor (RAP) and for history
   *  written before this existed — both mean "treat as on sale". */
  onSale?: boolean;
}

/** A full snapshot for one product, keyed by visit date 'YYYY-MM-DD'. */
export type Snapshot = Record<string, DayObs>;

/** A changed day, ready to append to D1. */
export interface Delta extends DayObs {
  date: string;
}

/* ── Ride queue times (Attractions.io live feed) ─────────────────────────────── */

/** One queue line's live state, as read from the live feed and joined to the
 *  static catalog. `queueLineId` is 0 for a synthesised ride-level "main" line
 *  (used before the catalog resolves, or for rides with no distinct QueueLine). */
export interface QueueObs {
  rideId: number;
  queueLineId: number;
  lineType: string | null;
  queueTime: number | null; // minutes; null when closed / not reporting
  status: string | null; // QueueStatusMessage
  isOpen: boolean; // ride-level
  isOperational: boolean; // ride-level
}

/** A queue snapshot: every tracked line keyed by `${rideId}:${queueLineId}`. */
export type QueueSnapshot = Record<string, QueueObs>;
