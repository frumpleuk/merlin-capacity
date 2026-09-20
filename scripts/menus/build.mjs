// Compile contrib/menus/merlin into one JSON the frontend imports at build
// time (the menus are small and change rarely, so they ship with the bundle
// rather than being fetched from R2 like the live calendar/queue files).
//
//   node scripts/menus/build.mjs            -> frontend/src/menus.generated.json
//
// Runs from `npm run build` via prebuild, so a forgotten rebuild can't ship
// stale menus.
import fs from "node:fs";
import path from "node:path";
import { DATE_DIR, PARK_DIRS, REPO, ROOT, readJson } from "./lib.mjs";

// One file per park, fetched by the Food tab, plus a tiny index that ships in
// the bundle so the nav knows which parks have anything without a round trip.
const OUT_DIR = path.join(REPO, "frontend/public/menu-data");
const INDEX = path.join(REPO, "frontend/src/menus.index.json");
const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const parkKey = Object.fromEntries(Object.entries(PARK_DIRS).map(([k, v]) => [v, k]));

/** A venue folder -> { slug, name, ..., menus: [{ date, sections, offers }] }. */
function venue(dir, slug, extra = {}) {
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
        passDiscount: m.passDiscount ?? null,
        base: `/menus/${path.relative(ROOT, path.join(dir, d))}/`,
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

  // Cheapest and dearest on the newest menu (ours or a sourced one) — enough to
  // place a venue without opening it.
  const prices = (menus[0]?.sections ?? []).flatMap((s) =>
    s.items.flatMap((i) => (i.sizes ? i.sizes.map((z) => z.price) : [i.price])).filter((p) => p != null),
  );

  return {
    slug,
    name: poi.display ?? poi.name ?? slug,
    area: poi.area ?? extra.eventArea ?? null,
    category: poi.category ?? null,
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
    ...extra,
    menus,
  };
}

const parks = {};
for (const parkDir of dirs(ROOT)) {
  const key = parkKey[parkDir];
  if (!key) continue;
  const base = path.join(ROOT, parkDir);
  const venues = [];
  const water = [];
  const events = [];

  for (const name of dirs(base)) {
    const dir = path.join(base, name);
    if (name === "water") {
      for (const w of dirs(dir)) {
        const v = venue(path.join(dir, w), w);
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
          const got = venue(path.join(evDir, v), v, { event: e, eventArea: ev.area ?? null });
          if (got) vendors.push(got);
        }
        events.push({ slug: e, ...ev, vendors });
      }
    } else if (!name.startsWith("_")) {
      const v = venue(dir, name);
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
  // Area labels for the map (sync-venues writes them from the app's own map).
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
  index[key] = {
    venues: park.venues.length,
    priced: park.venues.filter((v) => v.menus.length).length,
    water: park.water.length,
  };
  console.log(
    `${key}: ${park.venues.length} venues, ${index[key].priced} with menus, ` +
      `${park.venues.reduce((n, v) => n + v.menus.length, 0)} menus, ${(size / 1024).toFixed(0)}KB`,
  );
}
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + "\n");
console.log(`${(total / 1024).toFixed(0)}KB total, fetched per park; index ${path.relative(REPO, INDEX)}`);
