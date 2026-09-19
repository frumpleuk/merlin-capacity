// Shared helpers for the menu-photo tooling. See contrib/menus/README.md for
// the folder layout these scripts maintain.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ROOT = path.join(REPO, "contrib/menus/merlin");

/** Folder name under ROOT for each Attractions.io park key in src/config.ts. */
export const PARK_DIRS = {
  alton_towers: "alton-towers",
  thorpe_park: "thorpe-park",
  legoland: "legoland",
  chessington: "chessington-world-of-adventures",
};

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
  const walk = (d) => {
    if (fs.existsSync(path.join(d, "poi.json"))) out.push({ dir: d, poi: readJson(path.join(d, "poi.json")) });
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !DATE_DIR.test(e.name)) walk(path.join(d, e.name));
    }
  };
  walk(parkDir);
  return out;
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
