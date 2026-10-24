// Refresh the venue folders for the three independent parks from their own
// apps: one folder per eatery, each with a poi.json, exactly as
// sync-venues.mjs does for the Merlin four. Existing folders keep their photos,
// menus and any hand-written poi.json keys; only the app-owned fields update.
// Never deletes: a venue that has left the app is stamped, not removed.
//
//   node scripts/menus/sync-venues-indie.mjs [park_key...] [--poi <file>]
//
// Each park has a different backend, and only two of the three can be read over
// the network (see docs/<park>-api.md for the full reverse-engineering):
//
//   blackpool     GET /api/app/v3/map/get-markers, type "food_drink", with a
//                 Sanctum bearer token from BPB_EMAIL / BPB_PASSWORD.
//   flamingoland  Firestore collections food_drink_data (the venues) joined to
//                 markers_data (the coordinates) on parkMapMarkerId.
//   drayton_manor the app's TE2 POI list (docs/drayton-api.md), POIs with a
//                 "Dining Type" tag, behind an anonymous token.
//   plopsaland    the app API's points of interest, type "foods_and_drinks"
//                 (docs/plopsa-api.md). They carry map pixels, not coordinates;
//                 those come from scripts/menus/plopsaland-locations.json, by
//                 name, copied from ThemeParks/parksapi (MIT,
//                 src/parks/plopsa/locations).
//   liseberg      the app API's restaurant/list (names and today's hours, no
//                 positions). A venue is placed where the one OpenStreetMap
//                 eatery inside the park outline with its name stands; a name
//                 that matches none, or several (Max), stays unplaced.
//   paultons      the app's bundled points_of_interest.json, type "restaurant".
//                 It ships inside the APK rather than being served, so pass an
//                 unpacked copy with --poi <file>; without it Paulton's is
//                 skipped and the committed poi.json files stand.
import "../dev-keys.mjs";
import fs from "node:fs";
import path from "node:path";
import { PARKS } from "../../src/config.ts";
import { INDIE_PARK_DIRS, REPO, coord, metres, parkDir, syncVenues, writeJson } from "./lib.mjs";

const config = (key) => PARKS.find((p) => p.key === key);
/** The queue API's Cloudflare WAF 403s desktop-browser UAs: send the app's own
 *  (the same rule src/bpb.ts works around). */
const BPB_UA = "PleasureBeachResort/3.2.3 (Android)";

const args = process.argv.slice(2);
const poiArg = args.indexOf("--poi");
const POI_FILE = poiArg >= 0 ? args[poiArg + 1] : process.env.PAULTONS_POI;
const wanted = args.filter((a, i) => !a.startsWith("--") && !(poiArg >= 0 && i === poiArg + 1));

/** Secrets live in .dev.vars (gitignored) locally and in the Worker in prod. */
function devVar(name) {
  if (process.env[name]) return process.env[name];
  const file = path.join(REPO, ".dev.vars");
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, "utf8").match(new RegExp(`^${name}\\s*=\\s*(.*)$`, "m"));
  return line ? line[1].trim().replace(/^["']|["']$/g, "") : null;
}

const decode = (s) =>
  String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();

/** Blackpool: the app's map markers, which carry the coordinates the queue feed
 *  doesn't. `filters` is the park's own taxonomy (Grab 'n' Go, Sit Down Dining,
 *  Licensed Bar, Sweet Treats and Desserts), so it becomes the category path. */
async function blackpool() {
  const email = devVar("BPB_EMAIL");
  const password = devVar("BPB_PASSWORD");
  if (!email || !password) {
    console.warn("! blackpool: no BPB_EMAIL/BPB_PASSWORD (set them in .dev.vars); skipped");
    return null;
  }
  const api = `${config("blackpool").queue.apiUrl}/api/app/v3`;
  const auth = await fetch(`${api}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": BPB_UA },
    body: JSON.stringify({ email, password }),
  });
  if (!auth.ok) throw new Error(`login ${auth.status}`);
  const { token } = await auth.json();
  const resp = await fetch(`${api}/map/get-markers`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": BPB_UA },
  });
  if (!resp.ok) throw new Error(`get-markers ${resp.status}`);
  const markers = await resp.json();
  return markers
    .filter((m) => m.type === "food_drink" && m.display !== false)
    .map((m) => {
      const filters = [...new Set((m.filters ?? []).map((f) => f.value))];
      return {
        id: m.id,
        name: decode(m.title),
        category: ["Food & Drink", ...filters].join(" > "),
        area: null, // the markers carry no land, and the park doesn't label them
        lat: coord(Number(m.lat)),
        lon: coord(Number(m.lon)),
        // Most of these are the park's own "<venue>-menu" page, which lists the
        // dishes; a few are the venue's own site. Both are the official menu.
        menuUrl: m.info_url || null,
        appMissingSince: null,
        source: "blackpool app map markers",
      };
    });
}

/** Flamingo Land: the venues are one Firestore collection and the coordinates
 *  another, joined on parkMapMarkerId. Five venues carry no marker id, so they
 *  get a folder and a name but no pin until the park fills that in. */
async function flamingoland() {
  const { projectId, apiKey } = config("flamingoland").queue;
  const auth = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!auth.ok) throw new Error(`anonymous sign-up ${auth.status}`);
  const { idToken } = await auth.json();

  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const read = async (collection) => {
    const docs = [];
    let pageToken = "";
    do {
      const url = `${base}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!r.ok) throw new Error(`${collection} ${r.status}`);
      const page = await r.json();
      docs.push(...(page.documents ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    // Firestore wraps every value in its type: {stringValue}, {integerValue}…
    return docs.map((d) => Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, Object.values(v)[0]])));
  };

  const markers = new Map((await read("markers_data")).map((m) => [String(m.id), m]));
  return (await read("food_drink_data")).map((v) => {
    const m = markers.get(String(v.parkMapMarkerId ?? ""));
    return {
      id: Number(v.id),
      name: decode(v.title),
      category: "Food & Drink", // the app's only food category
      // The park writes a sentence about what's sold ("Jacket Potatoes and Soft
      // Drinks", or a paragraph): useful to read, useless to group by.
      serves: decode(v.foodType) || null,
      area: area(v.parkLocation),
      lat: m ? coord(Number(m.lat)) : null,
      lon: m ? coord(Number(m.lng)) : null,
      menuUrl: null,
      appMissingSince: null,
      source: "flamingo land app (firestore)",
    };
  });
}

/** The app's park zones are slugs (muddy_duck_farm); these are the park's own
 *  names for them, and anything new falls back to a readable version. */
const FL_AREAS = {
  flamingo1: "Flamingo 1",
  riverside_one: "Riverside One",
  the_hub: "The Hub",
  muddy_duck_farm: "Muddy Duck Farm",
  childrens_planet: "Children's Planet",
  seaside_adventure: "Seaside Adventure",
  mansion_house_area: "Mansion House",
  holiday_resort: "Holiday Resort",
  metropolis: "Metropolis",
  splosh: "Splosh!",
  zoo: "Zoo",
};
const area = (key) =>
  key ? (FL_AREAS[key] ?? key.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase())) : null;

/** Paulton's: points_of_interest.json out of the app bundle. Food outlets are
 *  type "restaurant"; two of them carry a themed-area tag and the rest take the
 *  nearest area's centre, the same "near enough to group by" rule the Merlin
 *  sync uses for its map labels. */
function paultons(file) {
  const pois = JSON.parse(fs.readFileSync(file, "utf8"));
  const tags = new Map(); // category_tags_id -> name, read off the POIs themselves
  const tagNames = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "category_tags.json"), "utf8"));
  for (const t of tagNames) tags.set(t.id, t.name);
  const NOT_AN_AREA = /^(Rides|Attractions|Food and Drink|Shopping|Animals|Birds|Mammals|Playgrounds|Facilities|Toilets|Baby Changing|Smoking Areas|First Aid|Accessible Changing|Percy Trail)$/;

  const tagsOf = (p) =>
    (p.category_tags ?? []).map((t) => tags.get(typeof t.category_tags_id === "object" ? t.category_tags_id.id : t.category_tags_id));
  const at = (p) => {
    const c = p.location?.coordinates;
    return c ? { lat: c[1], lon: c[0] } : null;
  };

  // Each themed area's centre, averaged over everything tagged with it.
  const centres = new Map();
  for (const p of pois) {
    const here = at(p);
    if (!here) continue;
    for (const name of tagsOf(p)) {
      if (!name || NOT_AN_AREA.test(name)) continue;
      const acc = centres.get(name) ?? { lat: 0, lon: 0, n: 0 };
      centres.set(name, { lat: acc.lat + here.lat, lon: acc.lon + here.lon, n: acc.n + 1 });
    }
  }
  const lands = [...centres].map(([name, a]) => ({ name, lat: a.lat / a.n, lon: a.lon / a.n }));

  // A land's centre is a poor test in a park this compact (the areas interlock
  // and none is round), so an untagged outlet takes the area of the nearest
  // thing that IS tagged: the ride it stands next to.
  const tagged = pois
    .map((p) => ({ name: tagsOf(p).find((n) => n && !NOT_AN_AREA.test(n)), ...(at(p) ?? {}) }))
    .filter((p) => p.name && p.lat != null);
  const landFor = (lat, lon) => {
    if (lat == null || !tagged.length) return null;
    const near = tagged.map((a) => ({ ...a, m: metres(lat, lon, a.lat, a.lon) })).sort((a, b) => a.m - b.m)[0];
    return near.m < 150 ? near.name : null; // beyond that it's a guess
  };

  const records = pois
    .filter((p) => p.type === "restaurant")
    .map((p) => {
      const here = at(p);
      const own = tagsOf(p).find((n) => n && !NOT_AN_AREA.test(n));
      return {
        id: p.id,
        name: decode(p.title),
        category: "Food & Drink",
        area: own ?? landFor(here?.lat ?? null, here?.lon ?? null),
        lat: coord(here?.lat ?? null),
        lon: coord(here?.lon ?? null),
        // The park runs its menus on Tenkites: dishes, calories and allergens,
        // but no prices (see scripts/menus/import-tenkites.mjs).
        menuUrl: p.menu || null,
        // The bundle keeps closed outlets as "archived" rather than dropping
        // them, and says when: better history than waiting for one to vanish.
        appMissingSince: p.status === "archived" ? (p.date_updated ?? "").slice(0, 10) || null : null,
        source: "paultons app bundle",
      };
    });
  return { records, lands };
}

/** The centre of each named area, averaged over the venues in it. */
function centres(records) {
  const acc = new Map();
  for (const r of records) {
    if (!r.area || r.lat == null) continue;
    const a = acc.get(r.area) ?? { lat: 0, lon: 0, n: 0 };
    acc.set(r.area, { lat: a.lat + r.lat, lon: a.lon + r.lon, n: a.n + 1 });
  }
  return [...acc].map(([name, a]) => ({ name, lat: a.lat / a.n, lon: a.lon / a.n }));
}

/** Drayton Manor: the app's TE2 POIs with a "Dining Type" tag (Quick Service,
 *  Snacks, Cafe, Table Service). The tag also marks bookable functions and the
 *  hotel, which aren't places to eat in the park. The POIs carry no area, so a
 *  venue takes the area of the nearest ride, within 150m. */
const DRAYTON_NOT_A_VENUE = /birthday|conference|corporate|hotel/i;
async function drayton() {
  const cfg = config("drayton_manor").queue;
  const tok = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "dev-tool",
    },
    body: new URLSearchParams({
      grant_type: "urn:accesso:oauth2:grant-type:anonymous",
      scope: "anonymous openid service.all",
    }),
  });
  if (!tok.ok) throw new Error(`token ${tok.status}`);
  const { access_token } = await tok.json();
  const resp = await fetch(`${cfg.apiUrl}/api/v1/public/venues/${cfg.venueId}/pois/`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      appID: cfg.venueId,
      "X-Customer-ID": cfg.customerId,
      "User-Agent": "dev-tool",
    },
  });
  if (!resp.ok) throw new Error(`pois ${resp.status}`);
  const pois = await resp.json();
  const tag = (p, label) => (p.tags ?? []).find((t) => t.label === label)?.valueLabel?.trim();
  const rides = pois
    .map((p) => ({
      name: (p.details ?? []).find((d) => d.id === "internalActivity")?.value?.mountainArea?.trim(),
      lat: p.location?.lat,
      lon: p.location?.lon,
    }))
    .filter((r) => r.name && r.lat != null);
  const areaFor = (lat, lon) => {
    const near = rides.map((r) => ({ ...r, m: metres(lat, lon, r.lat, r.lon) })).sort((a, b) => a.m - b.m)[0];
    return near && near.m < 150 ? near.name : null;
  };
  return pois
    .filter((p) => tag(p, "Dining Type") && !DRAYTON_NOT_A_VENUE.test(p.label ?? ""))
    .map((p) => {
      const lat = p.location?.lat ?? null;
      const lon = p.location?.lon ?? null;
      return {
        id: p.id,
        name: decode(p.label),
        category: `Food & Drink > ${tag(p, "Dining Type")}`,
        area: lat != null ? areaFor(lat, lon) : null,
        lat: coord(lat),
        lon: coord(lon),
        menuUrl: null,
        appMissingSince: null,
        source: "drayton manor app (te2)",
      };
    });
}

/** Plopsaland: the app's food and drink POIs, categorised by the park's own
 *  service type (Take away, Restaurant, ...). */
async function plopsaland() {
  const cfg = config("plopsaland").queue;
  const resp = await fetch(`${cfg.apiUrl}/api/points-of-interest?language=en&park=${cfg.park}`, {
    headers: { "User-Agent": "dev-tool" },
  });
  if (!resp.ok) throw new Error(`pois ${resp.status}`);
  const { items } = await resp.json();
  const where = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/menus/plopsaland-locations.json"), "utf8"));
  return items
    .flatMap((i) => i.contains ?? [])
    .filter((p) => p.type === "foods_and_drinks" && p.title)
    .map((p) => {
      const name = decode(p.title);
      const at = where[p.title] ?? where[name];
      const kind = (p.categories ?? []).map((c) => c.label).filter(Boolean)[0];
      return {
        id: p.plopsa_id ?? p.id,
        name,
        category: kind ? `Food & Drink > ${kind}` : "Food & Drink",
        area: null,
        lat: coord(at?.latitude ?? null),
        lon: coord(at?.longitude ?? null),
        menuUrl: null,
        appMissingSince: null,
        source: "plopsa app api",
      };
    });
}

async function liseberg() {
  const cfg = config("liseberg").queue;
  const resp = await fetch(`${cfg.apiUrl}restaurant/list`, { headers: { "User-Agent": "dev-tool" } });
  if (!resp.ok) throw new Error(`restaurant/list ${resp.status}`);
  const list = await resp.json();
  const q = `[out:json][timeout:25];nwr["tourism"="theme_park"]["name"="Liseberg"](57.68,11.98,57.70,12.01)->.p;.p map_to_area->.a;(nwr["amenity"~"restaurant|cafe|fast_food|ice_cream|bar|pub|food_court"](area.a););out center tags;`;
  const osm = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "User-Agent": "dev-tool", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: q }),
  });
  if (!osm.ok) throw new Error(`overpass ${osm.status}`);
  const norm = (s) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const places = (await osm.json()).elements
    .filter((e) => e.tags?.name)
    .map((e) => ({ key: norm(e.tags.name), lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }));
  const placeOf = (name) => {
    const n = norm(name);
    let hits = places.filter((p) => p.key === n);
    if (!hits.length) hits = places.filter((p) => n.startsWith(p.key) || p.key.startsWith(n));
    return hits.length === 1 ? hits[0] : null;
  };
  return list.map((r) => {
    const name = decode(r.name);
    const at = placeOf(name);
    return {
      id: r.id,
      name,
      category: "Food & Drink",
      area: null,
      lat: coord(at?.lat ?? null),
      lon: coord(at?.lon ?? null),
      menuUrl: null,
      appMissingSince: null,
      source: "liseberg app api, positions from openstreetmap",
    };
  });
}

const SOURCES = { blackpool, flamingoland, drayton_manor: drayton, plopsaland, liseberg };

for (const key of Object.keys(INDIE_PARK_DIRS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  let records = null;
  let lands = [];
  if (key === "paultons") {
    if (!POI_FILE) {
      console.warn("! paultons: no --poi <points_of_interest.json> from the app bundle; skipped");
      continue;
    }
    ({ records, lands } = paultons(POI_FILE));
  } else {
    records = await SOURCES[key]();
  }
  if (!records) continue;

  const { seen, added } = syncVenues(key, records);
  // Map labels. Paulton's app tags its lands, so those centres come from the
  // whole POI set; elsewhere the venues' own areas are all there is to average.
  if (!lands.length) lands = centres(records);
  if (lands.length) {
    writeJson(
      path.join(parkDir(key), "areas.json"),
      lands.map((a) => ({ name: a.name, lat: coord(a.lat), lon: coord(a.lon) })),
    );
  }
  const placed = records.filter((r) => r.lat != null).length;
  console.log(`${INDIE_PARK_DIRS[key]}: ${seen.size} in app, ${placed} with coordinates, ${added} new folders`);
}
