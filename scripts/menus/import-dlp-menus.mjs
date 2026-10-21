// Fetch Disneyland Paris's own menu PDFs and say which venues need their
// menu.json (re)written.
//
//   node scripts/menus/import-dlp-menus.mjs
//
// Each restaurant's poi.json carries Disney's `menuUrl` (written by
// sync-venues-dlp.mjs): a designed, bilingual PDF with prices in euros. The
// layout differs per venue (set menus drawn as "drink + main + dessert",
// columns of French over English), so it isn't parsed here. This script
// downloads each PDF to a cache, hashes it, and compares the hash with the one
// recorded in the venue's newest menu.json. Anything new or changed is listed
// in the plan file for transcription (see the menus-transcribe skill), which
// writes `<venue>/<today>/menu.json` with:
//
//   "source": { "name": "Disneyland Paris", "official": true, "url": <pdf>, "sha256": <hash> }
//
// An unchanged PDF needs nothing; a changed one gets a new dated menu beside the
// old, which is the history. Fetching is one PDF a second.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATE_DIR, DLP_PARK_DIRS, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "dlp-menu-cache");
const PLAN = path.join(MENUS, ".dlp-plan.json");
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Download (fresh each run: the same URL is reused when Disney updates a menu). */
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

const plan = [];
for (const key of Object.keys(DLP_PARK_DIRS)) {
  for (const { dir, poi } of venues(parkDir(key))) {
    if (!poi.menuUrl || poi.appMissingSince) continue;
    let got;
    try {
      got = await pdf(poi.menuUrl);
    } catch (e) {
      console.warn(`! ${poi.name}: ${e.message}`);
      continue;
    }
    const prev = latestMenu(dir);
    if (prev?.source?.sha256 === got.sha256) continue;
    plan.push({
      park: key,
      venue: path.relative(MENUS, dir),
      name: poi.name,
      url: poi.menuUrl,
      sha256: got.sha256,
      pdf: got.file,
      out: path.relative(MENUS, path.join(dir, TODAY, "menu.json")),
      changed: !!prev,
    });
    console.log(`${prev ? "~ changed" : "+ new    "} ${path.relative(MENUS, dir)}`);
  }
}
writeJson(PLAN, plan);
console.log(`${plan.length} menus to transcribe; plan in ${path.relative(process.cwd(), PLAN)}`);
