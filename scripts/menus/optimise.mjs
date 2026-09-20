// Turn each original photo into a small, descriptively named JPEG that IS
// committed and gets served from R2:
//
//   <venue>/<date>/IMG_3425.HEIC   original, git-ignored, evidence only
//   <venue>/<date>/web/Mutiny-Bay-Hot-Dogs-loaded-spuds.jpg
//                                  1600px, EXIF stripped, committed
//
// Names are the venue's own name plus what the board is (its first section,
// or "main-menu" when the venue has a single board; "sign", "allergens",
// "duplicate", "offer" for the rest). Once assigned a name is recorded in
// menu.json `photos` and never changes, so the R2 key stays stable.
//
//   node scripts/menus/optimise.mjs [--force]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATE_DIR, PHOTO_EXT, ROOT, readJson, slug, writeJson } from "./lib.mjs";

const MAX_PX = 1600;
const QUALITY = 72;
const force = process.argv.includes("--force");

/** The venue's own name, as a filename: "BOMBAYish", "Mutiny-Bay-Hot-Dogs". */
function venueName(dir, fallback) {
  const poiFile = path.join(dir, "poi.json");
  const name = fs.existsSync(poiFile) ? readJson(poiFile).name : null;
  return (
    (name ?? fallback)
      .replace(/&/g, " and ")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

/** What the popup says a photo shows: the boards it holds, as printed. */
function caption(menu, file) {
  const sections = (menu.sections ?? []).filter((s) => s.items.some((i) => i.photo === file));
  if (sections.length) return sections.map((s) => s.name).join(", ");
  if ((menu.offers ?? []).some((o) => o.photo === file)) return "Offer";
  return (menu.skipped ?? []).find((s) => s.photo === file)?.reason ?? "Photo";
}

/** The file's name: the venue plus what the board is, short enough for a URL. */
function describe(menu, file) {
  const sections = (menu.sections ?? []).filter((s) => s.items.some((i) => i.photo === file));
  if (sections.length) {
    // One board of menu per venue is simply the menu; several need telling
    // apart, so the board takes the name of the first section on it.
    const boards = new Set(
      (menu.sections ?? []).flatMap((s) => s.items.map((i) => i.photo)).filter(Boolean),
    );
    return boards.size === 1 ? "main-menu" : shorten(sections[0].name, 3);
  }
  if ((menu.offers ?? []).some((o) => o.photo === file)) return "offer";
  const reason = (menu.skipped ?? []).find((s) => s.photo === file)?.reason ?? "";
  if (/sign|shopfront|frontage|fascia/i.test(reason)) return "sign";
  if (/allergen/i.test(reason)) return "allergens";
  if (/duplicate|same board|wider/i.test(reason)) return "duplicate";
  return reason ? shorten(reason, 3) : "photo";
}

/** The first few whole words, lowercased — short enough to read in a URL. */
function shorten(text, maxWords) {
  return slug(text).split("-").filter(Boolean).slice(0, maxWords).join("-") || "menu";
}

function nameFor(menu, file, taken, venue) {
  const recorded = (menu.photos ?? []).find((p) => p.file === file);
  if (recorded) return recorded.name;
  const base = `${venue}-${describe(menu, file)}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

let made = 0;
let skippedCount = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (!DATE_DIR.test(e.name)) {
      walk(p);
      continue;
    }
    const all = fs.readdirSync(p).filter((f) => PHOTO_EXT.test(f)).sort();
    if (!all.length) continue;
    const menuFile = path.join(p, "menu.json");
    if (!fs.existsSync(menuFile)) {
      // Names come from the menu's own section headings, so transcribe first.
      console.log(`? ${path.relative(ROOT, p)}: no menu.json yet, skipped`);
      continue;
    }
    const menu = readJson(menuFile);
    // Photos the transcription skipped (a duplicate of a board already read, a
    // shop sign, an allergen chart) stay on disk as evidence but get no web
    // copy: the site shows the boards the prices came from, nothing else.
    const skipped = new Set((menu.skipped ?? []).map((s) => s.photo));
    const photos = all.filter((f) => !skipped.has(f));
    if (!photos.length) {
      console.log(`? ${path.relative(ROOT, p)}: every photo is skipped, nothing to publish`);
      continue;
    }
    const webDir = path.join(p, "web");
    fs.mkdirSync(webDir, { recursive: true });

    const venue = venueName(dir, path.basename(dir)); // `dir` is the venue folder
    const taken = new Set((menu.photos ?? []).map((x) => x.name));
    const photoIndex = [];
    for (const file of photos) {
      const name = nameFor(menu, file, taken, venue);
      taken.add(name);
      photoIndex.push({ file, name, caption: caption(menu, file) });
      const out = path.join(webDir, `${name}.jpg`);
      if (fs.existsSync(out) && !force) {
        skippedCount++;
        continue;
      }
      execFileSync("magick", [
        path.join(p, file), "-auto-orient", "-resize", `${MAX_PX}x${MAX_PX}>`,
        "-strip", "-interlace", "Plane", "-quality", String(QUALITY), out,
      ]);
      made++;
      console.log(`${path.relative(ROOT, out)}  ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
    }
    // Drop web files whose photo or name no longer exists (renamed sections).
    const live = new Set(photoIndex.map((x) => `${x.name}.jpg`));
    for (const f of fs.readdirSync(webDir)) {
      if (!live.has(f)) {
        fs.rmSync(path.join(webDir, f));
        console.log(`- ${path.relative(ROOT, path.join(webDir, f))} (stale)`);
      }
    }
    writeJson(menuFile, { ...menu, photos: photoIndex });
  }
};

for (const park of fs.readdirSync(ROOT, { withFileTypes: true })) if (park.isDirectory()) walk(path.join(ROOT, park.name));
console.log(`${made} written, ${skippedCount} already current`);
