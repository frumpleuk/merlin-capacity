// A type-only import, so the node scripts can load this file as it is.
import type { ParkConfig } from "./config";

/**
 * The keys the parks' apps embed (Attractions.io api-keys, Paulton's x-token,
 * Flamingo Land's Firebase key, the Disneyland Paris x-api-key, Drayton Manor's
 * TE2 client secret) are kept out of the public repo, one Worker secret per
 * park, named by convention: `APP_KEY_` + the park key in upper case
 * (APP_KEY_ALTON_TOWERS). The two Disneyland Paris parks share
 * APP_KEY_DISNEYLAND_PARIS.
 *
 * Set each with `wrangler secret put APP_KEY_<PARK>`, and in .dev.vars for local
 * runs and the scripts. config.ts leaves each field empty and this fills them
 * into PARKS in place, once per isolate. A park whose key is missing keeps the
 * empty string, so its polls fail and log as failed.
 */

export const appKeyName = (park: ParkConfig): string =>
  `APP_KEY_${park.queue?.kind === "dlp" ? "DISNEYLAND_PARIS" : park.key.toUpperCase()}`;

let applied = false;

export function applyAppKeys(vars: Record<string, unknown>, parks: ParkConfig[]): void {
  if (applied) return;
  for (const park of parks) {
    const q = park.queue;
    const key = vars[appKeyName(park)];
    if (!q || typeof key !== "string" || !key) continue;
    switch (q.kind) {
      case "attractions":
      case "firestore":
      case "dlp":
        q.apiKey = key;
        break;
      case "fos":
        q.token = key;
        break;
      case "efteling":
        q.apiKey = key;
        break;
      case "te2":
        q.clientSecret = key;
        if (park.openingHours?.kind === "te2") park.openingHours.clientSecret = key;
        break;
    }
  }
  applied = true;
}
