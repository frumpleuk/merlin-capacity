// Check contrib/menus against the layout and menu.json schema in
// contrib/menus/README.md. Exits 1 on errors; warnings (e.g. photos not yet
// transcribed) don't fail.
//
//   node scripts/menus/validate.mjs
import fs from "node:fs";
import path from "node:path";
import { ALL_PARK_DIRS, DATE_DIR, MENUS, PHOTO_EXT, parkDir, readJson } from "./lib.mjs";

const TAGS = new Set(["v", "vg", "gf", "df", "alcohol", "kids"]);
const errors = [];
const warnings = [];
const rel = (p) => path.relative(MENUS, p);
const err = (p, m) => errors.push(`${rel(p)}: ${m}`);
const warn = (p, m) => warnings.push(`${rel(p)}: ${m}`);

const isPence = (n) => Number.isInteger(n) && n > 0;

function checkMenu(dir, photos) {
  const file = path.join(dir, "menu.json");
  let m;
  try {
    m = readJson(file);
  } catch (e) {
    return err(file, `unparseable: ${e.message}`);
  }
  if (m.date !== path.basename(dir)) err(file, `date "${m.date}" != folder name`);
  if (!Array.isArray(m.sections)) return err(file, "sections must be an array");
  // A menu is either ours (photos of the boards) or someone else's (a source
  // we credit). Sourced menus have no photos, so items cite none.
  const sourced = !!m.source;
  // Some official menus publish the dishes but no prices (Paulton's Tenkites
  // boards, Blackpool's venue pages). That's a fact about the menu, not an
  // unreadable photo, so it's said once here rather than per item.
  const unpriced = m.unpriced === true;
  if (unpriced && !sourced) err(file, "unpriced menus must say where they came from");
  if (sourced) {
    if (!m.source.name || !m.source.url) err(file, "source needs a name and a url");
    if (photos.length) err(file, "a sourced menu should not also hold photos");
  } else if (!photos.length) {
    err(file, "no photos and no source: where did this menu come from?");
  }

  const used = new Set();
  const usePhoto = (where, p) => {
    if (!photos.includes(p)) err(file, `${where}: photo "${p}" not in this folder`);
    used.add(p);
  };
  m.sections.forEach((s, si) => {
    const at = `sections[${si}] ${s.name ?? "?"}`;
    if (!s.name) err(file, `${at}: missing name`);
    if (!Array.isArray(s.items) || !s.items.length) err(file, `${at}: no items`);
    (s.items ?? []).forEach((it, ii) => {
      const where = `${at} items[${ii}] ${it.name ?? "?"}`;
      if (!it.name) err(file, `${where}: missing name`);
      if (it.photo) usePhoto(where, it.photo);
      else if (!sourced) err(file, `${where}: missing photo`);
      const hasPrice = it.price !== undefined;
      const hasSizes = Array.isArray(it.sizes);
      if (hasPrice === hasSizes) err(file, `${where}: needs exactly one of price or sizes`);
      if (hasPrice && it.price !== null && !isPence(it.price)) err(file, `${where}: price must be integer pence`);
      if (it.price === null && !it.unclear && !unpriced) err(file, `${where}: price null without "unclear" reason`);
      for (const sz of it.sizes ?? []) {
        if (!sz.label) err(file, `${where}: size missing label`);
        if (sz.price !== null && !isPence(sz.price)) err(file, `${where}: size "${sz.label}" price must be integer pence`);
        if (sz.price === null && !it.unclear && !unpriced) err(file, `${where}: size price null without "unclear" reason`);
      }
      if (it.kcal !== undefined && !(Number.isInteger(it.kcal) && it.kcal >= 0)) err(file, `${where}: kcal must be an integer`);
      for (const t of it.tags ?? []) if (!TAGS.has(t)) err(file, `${where}: unknown tag "${t}"`);
    });
  });
  const pd = m.passDiscount;
  if (pd) {
    if (typeof pd.offered !== "boolean") err(file, "passDiscount: offered must be true/false");
    if (pd.percent != null && !(Number.isInteger(pd.percent) && pd.percent > 0 && pd.percent < 100))
      err(file, "passDiscount: percent must be a whole percentage or null");
    if (pd.offered === false && pd.percent != null) err(file, "passDiscount: percent set but not offered");
    if (pd.upTo !== undefined && typeof pd.upTo !== "boolean") err(file, "passDiscount: upTo must be true/false");
    if (pd.photo) usePhoto("passDiscount", pd.photo);
  }
  for (const [i, o] of (m.offers ?? []).entries()) {
    if (!o.text) err(file, `offers[${i}]: missing text`);
    if (o.photo) usePhoto(`offers[${i}]`, o.photo);
  }
  if (sourced) return; // nothing below applies: no photos to index
  for (const [i, s] of (m.skipped ?? []).entries()) {
    if (!s.reason) err(file, `skipped[${i}]: missing reason`);
    usePhoto(`skipped[${i}]`, s.photo);
  }
  for (const p of photos) if (!used.has(p)) err(file, `photo ${p} not used by any item/offer and not in skipped`);

  // `photos` is written by optimise.mjs: the web copy's name for each original.
  // Absent until that has run; wrong once it has is an error, because the names
  // are the R2 keys the site links to.
  if (!m.photos) return warn(file, "no web photos yet; run scripts/menus/optimise.mjs");
  // Skipped photos are evidence only — they get no web copy and no index entry.
  const skipped = new Set((m.skipped ?? []).map((s) => s.photo));
  const names = new Set();
  for (const [i, p] of m.photos.entries()) {
    if (!photos.includes(p.file)) err(file, `photos[${i}]: "${p.file}" not in this folder`);
    if (!p.name || !/^[A-Za-z0-9-]+$/.test(p.name)) err(file, `photos[${i}]: bad web name "${p.name}"`);
    if (names.has(p.name)) err(file, `photos[${i}]: duplicate web name "${p.name}"`);
    names.add(p.name);
    if (!fs.existsSync(path.join(dir, "web", `${p.name}.jpg`))) err(file, `photos[${i}]: web/${p.name}.jpg missing`);
  }
  for (const p of photos) {
    if (skipped.has(p)) {
      if (m.photos.some((x) => x.file === p)) err(file, `photo ${p} is skipped but has a web copy`);
    } else if (!m.photos.some((x) => x.file === p)) {
      err(file, `photo ${p} has no web copy in photos`);
    }
  }
}

function walkVenue(dir, { needPoi }) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (needPoi && !fs.existsSync(path.join(dir, "poi.json"))) err(dir, "missing poi.json");
  if (fs.existsSync(path.join(dir, "poi.json"))) {
    const poi = readJson(path.join(dir, "poi.json"));
    if (!poi.name) warn(dir, "poi.json has no name");
    if (poi.lat == null) warn(dir, "poi.json has no location");
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && PHOTO_EXT.test(e.name)) err(p, "photo outside a dated folder");
    if (!e.isDirectory()) continue;
    if (DATE_DIR.test(e.name)) {
      const photos = fs.readdirSync(p).filter((f) => PHOTO_EXT.test(f));
      if (fs.existsSync(path.join(p, "menu.json"))) checkMenu(p, photos);
      else if (photos.length) warn(p, `${photos.length} photos, no menu.json yet`);
    } else walkVenue(p, { needPoi: !e.name.startsWith("_") });
  }
}

for (const key of Object.keys(ALL_PARK_DIRS)) {
  const parkPath = parkDir(key);
  if (!fs.existsSync(parkPath)) continue;
  for (const e of fs.readdirSync(parkPath, { withFileTypes: true })) {
    const p = path.join(parkPath, e.name);
    if (e.isFile() && PHOTO_EXT.test(e.name)) warn(p, "loose photo; run ingest.mjs plan");
    if (!e.isDirectory()) continue;
    if (e.name === "water") {
      for (const w of fs.readdirSync(p, { withFileTypes: true })) if (w.isDirectory()) walkVenue(path.join(p, w.name), { needPoi: true });
    } else if (e.name === "_events") {
      for (const ev of fs.readdirSync(p, { withFileTypes: true })) {
        if (!ev.isDirectory()) continue;
        const evDir = path.join(p, ev.name);
        if (!/^\d{4}-[a-z0-9-]+$/.test(ev.name)) err(evDir, "event folder must be <year>-<slug>");
        if (!fs.existsSync(path.join(evDir, "event.json"))) err(evDir, "missing event.json");
        else if (!readJson(path.join(evDir, "event.json")).name) err(evDir, "event.json has no name");
        walkVenue(evDir, { needPoi: false });
      }
    } else walkVenue(p, { needPoi: !e.name.startsWith("_") });
  }
}

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
