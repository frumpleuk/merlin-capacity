export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Secret gating the manual /poll trigger. Set via `wrangler secret put
   *  POLL_KEY` (prod) or .dev.vars (local). If unset, /poll is denied. */
  POLL_KEY?: string;
}

export type Product = "main" | "rap";

/** One day's numbers for one product. */
export interface DayObs {
  capacity: number;
  available: number;
  used: number;
  packageIds: string;
}

/** A full snapshot for one product, keyed by visit date 'YYYY-MM-DD'. */
export type Snapshot = Record<string, DayObs>;

/** A changed day, ready to append to D1. */
export interface Delta extends DayObs {
  date: string;
}
