// Refresh the venue folders for Disneyland Paris's two parks from Disney's own
// GraphQL API: one folder per restaurant, each with a poi.json, as the other
// syncs do. Existing folders keep their menus and hand-written poi.json keys;
// only the app-owned fields update. Never deletes.
//
//   node scripts/menus/sync-venues-dlp.mjs [park_key...]
//
// The API is unauthenticated (see docs/disneylandparis-api.md). Each
// restaurant carries its park (`location.id`), land, coordinates, Disney's
// service types and price band, and a link to its menu PDF, which
// import-dlp-menus.mjs reads.
import "../dev-keys.mjs";
import path from "node:path";
import { PARKS } from "../../src/config.ts";
import { DLP_PARK_DIRS, coord, parkDir, syncVenues, writeJson } from "./lib.mjs";

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const QUERY =
  "query restaurants($market:String!,$types:[String]){activities(market:$market,types:$types)" +
  "{id name location{id} subLocation{value} coordinates{lat lng}" +
  " ... on Restaurant{menuUrl serviceTypes{value} price{value}}}}";

async function restaurants(graphqlUrl) {
  const resp = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-application-id": "mobile-app", "user-agent": "dev-tool" },
    body: JSON.stringify({
      operationName: "restaurants",
      variables: { market: "en-gb", types: ["Restaurant"] },
      query: QUERY,
    }),
  });
  if (!resp.ok) throw new Error(`graphql ${resp.status}`);
  const body = await resp.json();
  if (!body.data?.activities) throw new Error(`graphql: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
  return body.data.activities;
}

/** Some names carry a trailing zero-width space; so do some service types. */
const clean = (s) => String(s ?? "").replace(/[​-‍﻿]/g, "").trim();

/** Service types mix what a place is ("Quick Service Restaurant", "Table
 *  service", "Snacks") with how you book or pay ("Online bookings", "Click &
 *  Collect"). Only the first kind is a category. */
const NOT_A_KIND = /booking|click|collect|mobile order|dining plan/i;

let all = null;
for (const [key, dir] of Object.entries(DLP_PARK_DIRS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const park = PARKS.find((p) => p.key === key);
  all ??= await restaurants(park.queue.graphqlUrl);
  const records = all
    .filter((r) => r.location?.id === park.queue.parkId)
    .map((r) => {
      const kinds = (r.serviceTypes ?? []).map((t) => clean(t.value)).filter((t) => t && !NOT_A_KIND.test(t));
      const at = r.coordinates?.[0];
      return {
        id: r.id,
        name: clean(r.name),
        category: ["Food & Drink", ...kinds].join(" > "),
        area: clean(r.subLocation?.value) || null,
        lat: coord(at?.lat ?? null),
        lon: coord(at?.lng ?? null),
        menuUrl: r.menuUrl || null,
        // Disney's own price band: "€", "€€" or "€€€".
        priceBand: r.price?.value ?? null,
        appMissingSince: null,
        source: "disneyland paris graphql",
      };
    });

  const { seen, added } = syncVenues(key, records);
  // Map labels: the centre of each land, averaged over its venues.
  const acc = new Map();
  for (const r of records) {
    if (!r.area || r.lat == null) continue;
    const a = acc.get(r.area) ?? { lat: 0, lon: 0, n: 0 };
    acc.set(r.area, { lat: a.lat + r.lat, lon: a.lon + r.lon, n: a.n + 1 });
  }
  writeJson(
    path.join(parkDir(key), "areas.json"),
    [...acc].map(([name, a]) => ({ name, lat: coord(a.lat / a.n), lon: coord(a.lon / a.n) })),
  );
  const withMenu = records.filter((r) => r.menuUrl).length;
  console.log(`${dir}: ${seen.size} restaurants, ${withMenu} with a menu PDF, ${added} new folders`);
}
