/**
 * Season-ticket package names learned from the live catalog.
 *
 * A park can sell a whole season under its own package name rather than the
 * usual day ticket: Thorpe's Fright Nights is "Fright Nights Entry". When that
 * name isn't in the product's P[], every date in the season reports from the
 * prebook anchors alone and reads as passholder-only, which was wrong on 24
 * Thorpe dates. Hardcoding the names doesn't survive the next season.
 *
 * special-days.ts derives and verifies these; discover.ts folds them into the
 * day-ticket match. Kept in its own module so those two don't import each other.
 */
const key = (park: string, product: string) => `catalog/${park}/${product}-season.json`;

export interface SeasonNamesFile {
  generated_at: string;
  /** Verified merge-safe names, folded into the day-ticket match by discovery. */
  names: string[];
  /** Candidates that look like a season but poison the merge (docs §3.1), so
   *  they need a product of their own. Recorded for a human, never applied. */
  rejected: { name: string; reason: string }[];
}

/** Names discovery should treat as the public day ticket, on top of the
 *  configured ones. Empty until the daily job has verified some. */
export async function readSeasonNames(
  bucket: R2Bucket,
  park: string,
  product: string,
): Promise<string[]> {
  const obj = await bucket.get(key(park, product));
  if (!obj) return [];
  try {
    const f = (await obj.json()) as Partial<SeasonNamesFile>;
    return Array.isArray(f.names) ? f.names : [];
  } catch {
    return [];
  }
}

export async function writeSeasonNames(
  bucket: R2Bucket,
  park: string,
  product: string,
  body: SeasonNamesFile,
): Promise<void> {
  await bucket.put(key(park, product), JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
}
