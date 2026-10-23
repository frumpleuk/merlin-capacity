// Fetch the parks' own menu PDFs and say which venues need their menu.json
// (re)written.
//
//   node scripts/menus/import-pdf-menus.mjs [park_key...]
//
// Any park, any venue whose menu link is a PDF: `displayMenuUrl` (set by hand,
// see contrib/menus/README.md) or else the app's `menuUrl`, or every URL in a
// hand-set `menuPdfs` list when a venue publishes more than one (main and
// kids). The layouts differ per park and per venue, and some are outlined text
// with nothing to extract, so nothing is parsed here. This script downloads
// each PDF to a cache, hashes it, and compares the hash with the one recorded
// in the venue's newest menu.json. Anything new or changed is listed in the
// plan file for transcription (see the menus-transcribe skill), which writes
// `<venue>/<today>/menu.json` with:
//
//   "source": { "name": <park>, "official": true, "url": <first pdf>, "sha256": <hash> }
//
// An unchanged PDF needs nothing; a changed one gets a new dated menu beside the
// old, which is the history. Fetching is one PDF a second.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARKS } from "../../src/config.ts";
import { ALL_PARK_DIRS, DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "park-menu-pdfs");
const PLAN = path.join(MENUS, ".pdf-plan.json");
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPdf = (url) => /\.pdf(?:[?#]|$)/i.test(url ?? "");

/** Download (fresh each run: parks reuse a URL when they update a menu). */
async function pdf(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, slug(url.replace(/^https?:\/\//, "")) + ".pdf");
  const resp = await fetch(url, { headers: { "user-agent": UA } });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(file, buf);
  await sleep(1000);
  return { file, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

/** The newest menu.json in a venue folder, if any. */
function latestMenu(dir) {
  const dates = fs
    .readdirSync(dir)
    .filter((d) => DATE_DIR.test(d) && fs.existsSync(path.join(dir, d, "menu.json")))
    .sort();
  return dates.length ? readJson(path.join(dir, dates.at(-1), "menu.json")) : null;
}

const wanted = process.argv.slice(2);
const plan = [];
for (const key of Object.keys(ALL_PARK_DIRS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  const park = PARKS.find((p) => p.key === key)?.label ?? key;
  const dir0 = parkDir(key);
  if (!fs.existsSync(dir0)) continue;
  for (const { dir, poi } of venues(dir0)) {
    if (poi.appMissingSince || poi.goneSince) continue;
    const urls = (poi.menuPdfs ?? [poi.displayMenuUrl ?? poi.menuUrl]).filter(isPdf);
    if (!urls.length) continue;
    const got = [];
    for (const url of urls) {
      try {
        got.push(await pdf(url));
      } catch (e) {
        console.warn(`! ${poi.name}: ${e.message}`);
      }
    }
    if (got.length !== urls.length) continue;
    // One PDF: its own hash. Several: the hash of their hashes, in list order.
    const sha256 =
      got.length === 1
        ? got[0].sha256
        : crypto.createHash("sha256").update(got.map((g) => g.sha256).join("\n")).digest("hex");
    const prev = latestMenu(dir);
    if (prev?.source?.sha256 === sha256) continue;
    plan.push({
      park: key,
      source: park,
      venue: path.relative(MENUS, dir),
      name: poi.display ?? poi.name,
      urls,
      sha256,
      pdfs: got.map((g) => g.file),
      out: path.relative(MENUS, path.join(dir, TODAY, "menu.json")),
      changed: !!prev,
    });
    console.log(`${prev ? "~ changed" : "+ new    "} ${path.relative(MENUS, dir)}`);
  }
}
writeJson(PLAN, plan);
console.log(`${plan.length} menus to transcribe; plan in ${path.relative(process.cwd(), PLAN)}`);
