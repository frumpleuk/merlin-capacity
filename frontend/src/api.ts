export interface DayObs {
  capacity: number;
  available: number;
  used: number;
  packageIds: string;
}

export interface ProductFile {
  park: string;
  product: string;
  generated_at: string;
  days: Record<string, DayObs>;
}

/** Fetch one product's precomputed file from R2 (via the Worker). Returns null
 *  if it's missing or empty — the poller may not cover this product yet. */
export async function loadProduct(
  park: string,
  product: string,
): Promise<ProductFile | null> {
  const r = await fetch(`/calendar/${park}/${product}.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as ProductFile;
  return Object.keys(f.days || {}).length > 0 ? f : null;
}

/** One location's opening hours for a day, classified by the backend: `event`
 *  is set when the API's lastEntryTime field was actually a special-event name. */
export interface LocationHours {
  kind: string; // "themepark" | "waterpark" | "golf"
  name: string;
  hours: string;
  lastEntry?: string;
  event?: string;
}

export interface HoursDay {
  locations: LocationHours[];
  event?: string; // the themepark's special event, bubbled up for the whole day
}

export interface HoursFile {
  park: string;
  generated_at: string;
  days: Record<string, HoursDay>;
}

/** Fetch a park's opening-hours file from R2. Returns null if absent/empty. */
export async function loadHours(park: string): Promise<HoursFile | null> {
  const r = await fetch(`/calendar/${park}/hours.json`, { cache: "no-store" });
  if (!r.ok) return null;
  const f = (await r.json()) as HoursFile;
  return Object.keys(f.days || {}).length > 0 ? f : null;
}
