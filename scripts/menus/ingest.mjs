// File new menu photos into <park>/<venue>/<YYYY-MM-DD>/.
//
// New photos are dropped loose into a park folder (contrib/menus/merlin/<park>/).
//
//   node scripts/menus/ingest.mjs plan
//     Reads EXIF of every loose photo, suggests the nearest venue by GPS and
//     writes contrib/menus/.ingest-plan.json. Prints each photo with its three
//     nearest venues so a human or agent can correct the guesses.
//   node scripts/menus/ingest.mjs sheets
//     Converts the planned photos to JPEG and tiles them 4x3 into labelled
//     contact sheets (needs sips + ImageMagick); prints the sheet paths.
//   node scripts/menus/ingest.mjs apply
//     Moves each photo (and its Live Photo .MOV/.MP4 sidecar) to the plan's
//     venue under a folder named for the capture date. A venue path that does
//     not exist yet is created with a poi.json located from the photos' GPS.
//
// Plan entries: { file, taken, lat, lon, venue, candidates }. Edit `venue` to a
// path relative to the park folder (e.g. "_events/2026-scarefest/some-vendor"),
// or set it to null to leave the photo where it is.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PHOTO_EXT, ROOT, exif, metres, readJson, sidecars, venues, writeJson } from "./lib.mjs";

const PLAN = path.join(ROOT, "..", ".ingest-plan.json");
const SHEETS = path.join(os.tmpdir(), "menu-sheets");

function loosePhotos() {
  const out = [];
  for (const park of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!park.isDirectory()) continue;
    const dir = path.join(ROOT, park.name);
    for (const f of fs.readdirSync(dir)) if (PHOTO_EXT.test(f)) out.push(path.join(dir, f));
  }
  return out.sort();
}

function plan() {
  const photos = exif(loosePhotos());
  const byPark = new Map();
  const entries = photos.map((p) => {
    const parkDir = path.dirname(p.file);
    if (!byPark.has(parkDir)) byPark.set(parkDir, venues(parkDir).filter((v) => v.poi.lat != null));
    const candidates =
      p.lat == null
        ? []
        : byPark
            .get(parkDir)
            .map((v) => ({
              venue: path.relative(parkDir, v.dir),
              name: v.poi.name,
              metres: Math.round(metres(p.lat, p.lon, v.poi.lat, v.poi.lon)),
            }))
            .sort((a, b) => a.metres - b.metres)
            .slice(0, 3);
    return {
      file: path.relative(ROOT, p.file),
      taken: p.taken,
      lat: p.lat,
      lon: p.lon,
      venue: candidates[0]?.venue ?? null,
      candidates,
    };
  });
  if (!entries.length) return console.log("no loose photos in any park folder");
  writeJson(PLAN, entries);
  for (const e of entries) {
    const near = e.candidates.map((c) => `${c.venue} ${c.metres}m`).join(", ") || "no GPS";
    console.log(`${e.file}  ${e.taken ?? "no date"}  ${near}`);
  }
  console.log(`\n${entries.length} photos -> ${path.relative(process.cwd(), PLAN)}`);
}

function sheets() {
  const entries = readJson(PLAN);
  fs.rmSync(SHEETS, { recursive: true, force: true });
  fs.mkdirSync(SHEETS, { recursive: true });
  const jpgs = entries.map((e) => {
    const out = path.join(SHEETS, path.basename(e.file).replace(/\.[^.]+$/, ".jpg"));
    execFileSync("sips", ["-s", "format", "jpeg", "-Z", "2000", path.join(ROOT, e.file), "--out", out], {
      stdio: "ignore",
    });
    return out;
  });
  for (let i = 0; i < jpgs.length; i += 12) {
    const sheet = path.join(SHEETS, `sheet-${String(i / 12 + 1).padStart(2, "0")}.jpg`);
    execFileSync("magick", [
      "montage", "-label", "%t", ...jpgs.slice(i, i + 12),
      "-geometry", "600x450+4+4", "-tile", "4x", "-pointsize", "28", sheet,
    ], { stdio: ["ignore", "inherit", "ignore"] }); // ImageMagick warns about fonts on stderr
    console.log(sheet);
  }
  console.log(`full-size JPEGs: ${SHEETS}`);
}

function apply() {
  const entries = readJson(PLAN);
  const moved = new Map(); // venue dir -> photos moved there (for new poi.json)
  for (const e of entries) {
    if (!e.venue) continue;
    if (!e.taken) throw new Error(`${e.file}: no capture date; set "taken" in the plan`);
    const src = path.join(ROOT, e.file);
    const venueDir = path.join(path.dirname(src), e.venue);
    const dest = path.join(venueDir, e.taken.slice(0, 10));
    fs.mkdirSync(dest, { recursive: true });
    for (const f of [src, ...sidecars(src)]) fs.renameSync(f, path.join(dest, path.basename(f)));
    if (!moved.has(venueDir)) moved.set(venueDir, []);
    moved.get(venueDir).push(e);
    console.log(`${e.file} -> ${path.relative(ROOT, dest)}/`);
  }
  for (const [dir, es] of moved) {
    if (fs.existsSync(path.join(dir, "poi.json"))) continue;
    const gps = es.filter((e) => e.lat != null);
    const mean = (k) => (gps.length ? +(gps.reduce((s, e) => s + e[k], 0) / gps.length).toFixed(6) : null);
    writeJson(path.join(dir, "poi.json"), {
      id: null,
      name: null,
      category: null,
      lat: mean("lat"),
      lon: mean("lon"),
      source: "photo GPS (mean)",
    });
    console.log(`new venue ${path.relative(ROOT, dir)}: fill in poi.json "name" (and "note")`);
  }
  fs.rmSync(PLAN);
}

const cmd = process.argv[2];
if (cmd === "plan") plan();
else if (cmd === "sheets") sheets();
else if (cmd === "apply") apply();
else {
  console.error("usage: ingest.mjs plan | sheets | apply");
  process.exit(1);
}
