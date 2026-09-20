// Shared helpers for the menu-photo tooling. See contrib/menus/README.md for
// the folder layout these scripts maintain.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MENUS = path.join(REPO, "contrib/menus");
/** The Merlin estate's root. Photo keys in R2 hang off an operator root, so
 *  this one can't move without breaking every URL already published. */
export const ROOT = path.join(MENUS, "merlin");

/** Folder name under ROOT for each Attractions.io park key in src/config.ts. */
export const PARK_DIRS = {
  alton_towers: "alton-towers",
  thorpe_park: "thorpe-park",
  legoland: "legoland",
  chessington: "chessington-world-of-adventures",
};

/** The independents are each their own operator, so each sits directly under
 *  contrib/menus rather than beside the Merlin four. Their app data comes from
 *  three different backends (see scripts/menus/sync-venues-indie.mjs). */
export const INDIE_PARK_DIRS = {
  paultons: "paultons",
  blackpool: "blackpool",
  flamingoland: "flamingoland",
};

/** Every park with menu folders, Merlin and independent alike. */
export const ALL_PARK_DIRS = { ...PARK_DIRS, ...INDIE_PARK_DIRS };

/** The operator root a park's folder sits under. Photo keys (and the site's
 *  /menus/ URLs) are relative to this, which is why it isn't just MENUS. */
export const parkRoot = (key) => (key in PARK_DIRS ? ROOT : MENUS);

/** Absolute path to a park's menu folder. */
export const parkDir = (key) => path.join(parkRoot(key), ALL_PARK_DIRS[key]);

export const PHOTO_EXT = /\.(heic|jpe?g|png)$/i;
export const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

export const slug = (s) =>
  s
    .normalize("NFKD")
    .replace(/[®™]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Metres between two lat/lon points (equirectangular; fine at park scale). */
export function metres(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.hypot(x, y) * 6371e3;
}

/** 6 decimal places is ~0.11m — far finer than a phone's GPS, and the app's
 *  12-digit values are false precision. */
export const coord = (n) => (n == null || Number.isNaN(n) ? null : +Number(n).toFixed(6));

export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
export const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

/** Every directory under `dir` (inclusive) that holds a poi.json: the venues. */
export function venues(parkDir) {
  const out = [];
  if (!fs.existsSync(parkDir)) return out; // a park whose first sync hasn't run
  const walk = (d) => {
    if (fs.existsSync(path.join(d, "poi.json"))) out.push({ dir: d, poi: readJson(path.join(d, "poi.json")) });
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !DATE_DIR.test(e.name)) walk(path.join(d, e.name));
    }
  };
  walk(parkDir);
  return out;
}

/** Create or refresh one venue folder per record, which is what every park's
 *  sync does once its backend has been read: fields the app owns are
 *  overwritten, anything recorded by hand (note, display, passDiscount)
 *  survives, and a venue that has left the app is stamped, never deleted.
 *
 *  A record is { id, name, water?, ...fields }: the id is the app's own and is
 *  what a folder is matched by, so a rename moves no files; the rest is written
 *  to poi.json as given.
 */
export function syncVenues(key, records) {
  const dir = parkDir(key);
  fs.mkdirSync(dir, { recursive: true });
  const root = parkRoot(key);
  const byId = new Map(
    venues(dir)
      .filter((v) => v.poi.id != null)
      .map((v) => [v.poi.id, v]),
  );
  const seen = new Set();
  let added = 0;
  for (const { water, ...fields } of records) {
    seen.add(fields.id);
    const existing = byId.get(fields.id);
    const venueDir = existing?.dir ?? path.join(dir, water ? "water" : "", slug(fields.name));
    if (!existing) {
      if (fs.existsSync(path.join(venueDir, "poi.json"))) {
        console.warn(
          `! ${path.relative(root, venueDir)} already has a poi.json for another id; skipped ${fields.name}`,
        );
        continue;
      }
      fs.mkdirSync(venueDir, { recursive: true });
      added++;
      console.log(`+ ${path.relative(root, venueDir)}`);
    }
    const prev = existing ? readJson(path.join(venueDir, "poi.json")) : {};
    if (existing && prev.name !== fields.name) {
      console.log(`~ ${path.relative(root, venueDir)}: renamed "${prev.name}" -> "${fields.name}"`);
    }
    writeJson(path.join(venueDir, "poi.json"), { ...prev, ...fields });
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
      console.log(`? ${path.relative(root, v.dir)}: id ${id} no longer in the app (marked ${today})`);
    }
  }
  return { seen, added };
}

/** EXIF capture time + GPS for photos, via exiftool (brew install exiftool). */
export function exif(files) {
  if (!files.length) return [];
  const raw = execFileSync(
    "exiftool",
    ["-n", "-j", "-DateTimeOriginal", "-GPSLatitude", "-GPSLongitude", ...files],
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  return JSON.parse(raw).map((r) => ({
    file: r.SourceFile,
    taken: r.DateTimeOriginal ? r.DateTimeOriginal.replace(/^(\d+):(\d+):(\d+) /, "$1-$2-$3T") : null,
    lat: r.GPSLatitude ?? null,
    lon: r.GPSLongitude ?? null,
  }));
}

/** Live Photo videos and other sidecars share the photo's basename. */
export function sidecars(photo) {
  const dir = path.dirname(photo);
  const base = path.basename(photo).replace(/\.[^.]+$/, "");
  return fs
    .readdirSync(dir)
    .filter((f) => f !== path.basename(photo) && f.replace(/\.[^.]+$/, "") === base)
    .map((f) => path.join(dir, f));
}
