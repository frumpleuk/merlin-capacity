// Refresh the venue folders from each Merlin park's official app content
// (Attractions.io bundle): one folder per eatery, one per water point under
// water/, each with a poi.json. Existing folders keep their photos, menus and
// any extra poi.json keys (e.g. "note"); only the app-owned fields update.
// Never deletes: venues that vanished from the app are reported, not removed.
//
//   node scripts/menus/sync-venues.mjs [park_key...]   (default: all four)
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { ATTRACTIONS_API, attractionsParks } from "../../src/config.ts";
import { PARK_DIRS, ROOT, coord, metres, readJson, slug, venues, writeJson } from "./lib.mjs";

const auth = (key, token) =>
  `Attractions-Io api-key="${key}"` + (token ? `, installation-token="${token}"` : "");

async function records(apiKey) {
  const reg = await fetch(`${ATTRACTIONS_API}/v1/installation`, {
    method: "POST",
    headers: {
      Authorization: auth(apiKey),
      "Idempotency-Key": crypto.randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      device_identifier: "123",
      user_identifier: crypto.randomUUID(),
      app_build: "100",
      app_version: "1.0",
    }),
  });
  if (!reg.ok) throw new Error(`register ${reg.status}`);
  const { token } = await reg.json();
  // 303 to a public S3 zip; read Location ourselves so auth isn't forwarded.
  const ptr = await fetch(`${ATTRACTIONS_API}/v1/data`, {
    redirect: "manual",
    headers: { Authorization: auth(apiKey, token), Date: new Date().toUTCString() },
  });
  const loc = ptr.headers.get("location");
  if (!loc) throw new Error(`/v1/data ${ptr.status}`);
  const zip = new Uint8Array(await (await fetch(loc)).arrayBuffer());
  const files = unzipSync(zip, { filter: (f) => f.name === "records.json" });
  return JSON.parse(new TextDecoder().decode(files["records.json"]));
}

const text = (n) => (n && typeof n === "object" ? n["en-GB"] ?? Object.values(n)[0] : n);
const INFO_ONLY = /^(Allergies & Intolerances|Food & Drink Information)$/;

/** Areas whose label is the whole resort or back-of-house, not a land. */
const NOT_A_LAND =
  /^(Root Area|.*Resort|Car Parks?|Entrance Plaza|Stargazing Pods.*|Admissions|Events? Marquee|.*Scare Maze.*|Front Lawns Arena)$/i;

// The app's Summary text is the park's own marketing copy, so we read FACTS out
// of it (dining plan, passholder discount) and never store or publish the prose.

/** "Dining Plan - Ultimate" / "Dining Plan - Classic" lines in the app text. */
const diningPlans = (summary) => [
  ...new Set([...(summary ?? "").matchAll(/Dining Plan\s*[-–]\s*([A-Za-z]+)/g)].map((m) => m[1])),
];

const wanted = process.argv.slice(2);
for (const park of attractionsParks()) {
  const dir = PARK_DIRS[park.key];
  if (!dir || (wanted.length && !wanted.includes(park.key))) continue;
  const r = await records(park.queue.apiKey);
  const cats = new Map(r.Category.map((c) => [c._id, c]));
  const catPath = (id) => {
    const out = [];
    for (let c = cats.get(id); c; c = cats.get(c.Parent)) out.unshift(text(c.Name));
    return out.join(" > ");
  };

  // Items don't name their land, so take the nearest area label that is one
  // (the app draws these labels on its map).
  const lands = (r.Area ?? [])
    .filter((a) => a.LabelLocation && !NOT_A_LAND.test(text(a.Name)))
    .map((a) => {
      const [lat, lon] = String(a.LabelLocation).split(",").map(Number);
      return { name: text(a.Name), lat, lon };
    });
  const landFor = (lat, lon) => {
    if (lat == null || !lands.length) return null;
    const near = lands
      .map((a) => ({ ...a, m: metres(lat, lon, a.lat, a.lon) }))
      .sort((a, b) => a.m - b.m)[0];
    return near.m < 400 ? near.name : null; // beyond that it's a guess
  };
  // Alton classifies passholder-discount outlets; Thorpe doesn't.
  const passIds = new Set(
    r.Classification.filter((c) => /Passholder Discount/i.test(text(c.Name))).map((c) => c._id),
  );

  const parkDir = path.join(ROOT, dir);
  const byId = new Map(venues(parkDir).filter((v) => v.poi.id != null).map((v) => [v.poi.id, v]));
  const seen = new Set();
  let added = 0;
  for (const item of r.Item) {
    const name = text(item.Name).trim();
    const category = catPath(item.Category);
    const food =
      /^(Food & Drink|Dining)/.test(category) && !/Freestyle/.test(category) && !INFO_ONLY.test(name);
    const water = /^Water\b/.test(name) && /^Facilities/.test(category);
    if (!food && !water) continue;
    seen.add(item._id);

    const [lat, lon] = (item.Location ?? ",").split(",").map(Number);
    const summary = text(item.Summary);
    const plans = diningPlans(summary);
    const appFields = {
      id: item._id,
      name,
      category,
      area: landFor(lat || null, lon || null),
      lat: coord(lat || null),
      lon: coord(lon || null),
      menuUrl: text(item.MenuURL) ?? null,
      // The app's own passholder-discount flag (Alton classifies these; Thorpe
      // doesn't, so absence is not a "no"). Hand-recorded passDiscount wins.
      appPassholderDiscount:
        (item.Classifications ?? []).some((c) => passIds.has(c)) ||
        /Passholder Discount available/i.test(summary ?? "")
          ? true
          : null,
      diningPlans: plans.length ? plans : null,
      appMissingSince: null,
      source: "attractions.io app bundle",
    };
    const existing = byId.get(item._id);
    const venueDir = existing?.dir ?? path.join(parkDir, water ? "water" : "", slug(name));
    if (!existing) {
      if (fs.existsSync(path.join(venueDir, "poi.json"))) {
        console.warn(`! ${dir}: ${path.relative(ROOT, venueDir)} already has a poi.json for another id; skipped ${name}`);
        continue;
      }
      fs.mkdirSync(venueDir, { recursive: true });
      added++;
      console.log(`+ ${path.relative(ROOT, venueDir)}`);
    }
    const prev = existing ? readJson(path.join(venueDir, "poi.json")) : {};
    if (existing && prev.name !== name) console.log(`~ ${path.relative(ROOT, venueDir)}: renamed "${prev.name}" -> "${name}"`);
    writeJson(path.join(venueDir, "poi.json"), { ...prev, ...appFields });
  }
  // Pop-ups and food-village stalls aren't in the app, but they stand in a land
  // like everything else — place them from their photos' GPS.
  for (const v of venues(parkDir)) {
    // Event stalls take their event's area (event.json), not the nearest label:
    // a food village pitched on a lawn is not part of the land next door.
    if (v.dir.includes(`${path.sep}_events${path.sep}`)) continue;
    if (v.poi.id != null || v.poi.area || v.poi.lat == null) continue;
    const area = landFor(v.poi.lat, v.poi.lon);
    if (area) {
      writeJson(path.join(v.dir, "poi.json"), { ...v.poi, area });
      console.log(`= ${path.relative(ROOT, v.dir)}: ${area}`);
    }
  }
  // Gone from the app: kept on disk, but stamped so the site can file it under
  // what used to be here rather than what's open today.
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, v] of byId) {
    if (seen.has(id)) continue;
    const f = path.join(v.dir, "poi.json");
    const poi = readJson(f);
    if (!poi.appMissingSince) {
      writeJson(f, { ...poi, appMissingSince: today });
      console.log(`? ${path.relative(ROOT, v.dir)}: id ${id} no longer in the app (marked ${today})`);
    }
  }
  console.log(`${dir}: ${seen.size} in app, ${added} new folders`);
}
