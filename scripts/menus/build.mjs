// Compile contrib/menus (the Merlin four and the three independents) into one
// JSON file per park for the Food tab, plus the index the nav reads.
//
//   node scripts/menus/build.mjs    -> frontend/public/menu-data/<park>.json
//                                      frontend/src/menus.index.json
//
// Runs from `npm run build` via prebuild, so a forgotten rebuild can't ship
// stale menus.
import fs from "node:fs";
import path from "node:path";
import { ALL_PARK_DIRS, DATE_DIR, REPO, parkDir, parkRoot, readJson } from "./lib.mjs";

// One file per park, fetched by the Food tab, plus a tiny index that ships in
// the bundle so the nav knows which parks have anything without a round trip.
const OUT_DIR = path.join(REPO, "frontend/public/menu-data");
const INDEX = path.join(REPO, "frontend/src/menus.index.json");
const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

/** A venue folder -> { slug, name, ..., menus: [{ date, sections, offers }] }. */
function venue(root, dir, slug, extra = {}) {
  const poiFile = path.join(dir, "poi.json");
  if (!fs.existsSync(poiFile)) return null;
  const poi = readJson(poiFile);
  const menus = dirs(dir)
    .filter((d) => DATE_DIR.test(d) && fs.existsSync(path.join(dir, d, "menu.json")))
    .sort()
    .reverse()
    .map((d) => {
      const m = readJson(path.join(dir, d, "menu.json"));
      // Items cite the camera original ("IMG_3425.HEIC"); the site shows the
      // committed web copy, so swap in its name and give the menu the R2 path
      // those names hang off (see publish.mjs and the worker's /menus/ route).
      const webName = new Map((m.photos ?? []).map((p) => [p.file, p.name]));
      const sections = (m.sections ?? []).map((s) => ({
        ...s,
        items: s.items.map((i) => ({ ...i, photo: webName.get(i.photo) ?? null })),
      }));
      return {
        date: m.date,
        approxDate: m.approxDate ?? false,
        source: m.source ?? null,
        // The source published the dishes but no prices.
        unpriced: m.unpriced ?? false,
        passDiscount: m.passDiscount ?? null,
        base: `/menus/${path.relative(root, path.join(dir, d))}/`,
        photos: (m.photos ?? []).map(({ name, caption }) => ({ name, caption })),
        sections,
        offers: (m.offers ?? []).map((o) => ({ ...o, photo: webName.get(o.photo) ?? null })),
      };
    });
  // What a Merlin Annual Pass gets you here, best evidence first: this visit's
  // boards, then anything we know by hand, then the park app's own flag.
  const passDiscount =
    menus.find((m) => m.passDiscount)?.passDiscount ??
    poi.passDiscount ??
    (poi.appPassholderDiscount ? { offered: true, percent: null, source: "park app" } : null);

  // Cheapest and dearest, from the newest menu that prices anything at all.
  // Some official menus (Paulton's, Blackpool) list the dishes but no prices,
  // so the newest menu is not always the one that can answer "how much?".
  const priced = (m) =>
    (m.sections ?? []).flatMap((s) =>
      s.items.flatMap((i) => (i.sizes ? i.sizes.map((z) => z.price) : [i.price])).filter((p) => p != null),
    );
  const pricedAt = menus.findIndex((m) => priced(m).length);
  const prices = pricedAt < 0 ? [] : priced(menus[pricedAt]);

  return {
    slug,
    name: poi.display ?? poi.name ?? slug,
    area: poi.area ?? extra.eventArea ?? null,
    category: poi.category ?? null,
    // What the park says this place sells, in its own words (Flamingo Land).
    serves: poi.serves ?? null,
    menuUrl: poi.menuUrl ?? null,
    diningPlans: poi.diningPlans ?? null,
    lat: poi.lat ?? null,
    lon: poi.lon ?? null,
    note: poi.note ?? null,
    // Gone from the park app: it's history, not somewhere to eat today.
    goneSince: poi.appMissingSince ?? null,
    passDiscount,
    items: (menus[0]?.sections ?? []).reduce((n, s) => n + s.items.length, 0),
    from: prices.length ? Math.min(...prices) : null,
    to: prices.length ? Math.max(...prices) : null,
    // Set only when the prices come from an older menu than the newest one, so
    // the card can say which year they are rather than implying they're current.
    priceDate: pricedAt > 0 ? menus[pricedAt].date : null,
    ...extra,
    menus,
  };
}

const parks = {};
for (const key of Object.keys(ALL_PARK_DIRS)) {
  const base = parkDir(key);
  if (!fs.existsSync(base)) continue;
  const root = parkRoot(key);
  const venues = [];
  const water = [];
  const events = [];

  for (const name of dirs(base)) {
    const dir = path.join(base, name);
    if (name === "water") {
      for (const w of dirs(dir)) {
        const v = venue(root, path.join(dir, w), w);
        if (v) water.push({ slug: v.slug, name: v.name, lat: v.lat, lon: v.lon });
      }
    } else if (name === "_events") {
      for (const e of dirs(dir)) {
        const evDir = path.join(dir, e);
        const ev = readJson(path.join(evDir, "event.json"));
        const vendors = [];
        for (const v of dirs(evDir)) {
          if (DATE_DIR.test(v)) continue;
          // A stall's "area" is where the event pitched, not the nearest land.
          const got = venue(root, path.join(evDir, v), v, { event: e, eventArea: ev.area ?? null });
          if (got) vendors.push(got);
        }
        events.push({ slug: e, ...ev, vendors });
      }
    } else if (!name.startsWith("_")) {
      const v = venue(root, dir, name);
      if (v) venues.push(v);
    }
  }
  // Park-wide offer posters (not a venue) travel with the park.
  const offersDir = path.join(base, "_park-wide-offers");
  const offers = fs.existsSync(offersDir)
    ? dirs(offersDir)
        .filter((d) => fs.existsSync(path.join(offersDir, d, "menu.json")))
        .flatMap((d) => (readJson(path.join(offersDir, d, "menu.json")).offers ?? []).map((o) => ({ ...o, date: d })))
    : [];

  venues.sort((a, b) => a.name.localeCompare(b.name));
  water.sort((a, b) => a.name.localeCompare(b.name));
  // Area labels for the map (the syncs write them from the app's own map).
  const areasFile = path.join(base, "areas.json");
  const areas = fs.existsSync(areasFile) ? readJson(areasFile) : [];
  parks[key] = { venues, water, events, offers, areas };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const index = {};
let total = 0;
for (const [key, park] of Object.entries(parks)) {
  const file = path.join(OUT_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(park) + "\n");
  const size = fs.statSync(file).size;
  total += size;
  // "priced" means a price you can actually read off the page. A venue whose
  // only menu is a dish list (the allergen boards Paulton's and Blackpool
  // publish) has a menu but no prices, and counting those as priced flattered
  // the coverage badly.
  const hasPrice = (v) =>
    v.menus.some((m) =>
      (m.sections ?? []).some((s) =>
        s.items.some((i) => i.price != null || (i.sizes ?? []).some((z) => z.price != null)),
      ),
    );
  index[key] = {
    venues: park.venues.length,
    withMenus: park.venues.filter((v) => v.menus.length).length,
    priced: park.venues.filter(hasPrice).length,
    water: park.water.length,
  };
  console.log(
    `${key}: ${park.venues.length} venues, ${index[key].priced} priced, ` +
      `${index[key].withMenus - index[key].priced} dish-list only, ` +
      `${park.venues.reduce((n, v) => n + v.menus.length, 0)} menus, ${(size / 1024).toFixed(0)}KB`,
  );
}
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + "\n");
console.log(`${(total / 1024).toFixed(0)}KB total, fetched per park; index ${path.relative(REPO, INDEX)}`);
