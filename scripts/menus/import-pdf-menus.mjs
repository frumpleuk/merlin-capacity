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
// old, which is the history. A PDF made before the venue's newest menu (an old
// sheet still linked after we photographed newer boards), or more than a year
// ago, is filed under the day the PDF was made, with `approxDate: true`. Fetching is one PDF a second. Every file fetched
// is copied to the private archive (archive-lib.mjs) and recorded in
// contrib/menus/archive.json, so the source outlives the park's link.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARKS } from "../../src/config.ts";
import { archive, saveLedger } from "./archive-lib.mjs";
import { archivePages } from "./archive-pages.mjs";
import { ALL_PARK_DIRS, DATE_DIR, DLP_PARK_DIRS, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "park-menu-pdfs");
const PLAN = path.join(MENUS, ".pdf-plan.json");
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_AGO = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
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

/** A venue's menu.json files, oldest first. */
function menus(dir) {
  return fs
    .readdirSync(dir)
    .filter((d) => DATE_DIR.test(d) && fs.existsSync(path.join(dir, d, "menu.json")))
    .sort()
    .map((d) => readJson(path.join(dir, d, "menu.json")));
}

/** The day a PDF was made, from its metadata (ModDate, else CreationDate). */
function made(file) {
  let info = "";
  try {
    info = execFileSync("pdfinfo", ["-isodates", file], { encoding: "utf8" });
  } catch {
    return null;
  }
  const date = (k) => info.match(new RegExp(`^${k}:\\s+(\\d{4}-\\d{2}-\\d{2})`, "m"))?.[1];
  return date("ModDate") ?? date("CreationDate") ?? null;
}

const wanted = process.argv.slice(2);
const plan = [];
for (const key of Object.keys(ALL_PARK_DIRS)) {
  if (wanted.length && !wanted.includes(key)) continue;
  // Disney's two parks publish as one resort.
  const park = key in DLP_PARK_DIRS ? "Disneyland Paris" : (PARKS.find((p) => p.key === key)?.label ?? key);
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
    // Keep a private copy of every file as fetched, before anything is read
    // from it: the park may change or delete it tomorrow.
    got.forEach((g, i) => archive({ file: g.file, sha256: g.sha256, url: urls[i], fetched: TODAY }));
    // One PDF: its own hash. Several: the hash of their hashes, in list order.
    const sha256 =
      got.length === 1
        ? got[0].sha256
        : crypto.createHash("sha256").update(got.map((g) => g.sha256).join("\n")).digest("hex");
    const all = menus(dir);
    // Already transcribed, as the current menu or as history.
    if (all.some((m) => m.source?.sha256 === sha256)) continue;
    const prev = all.at(-1);
    // A PDF older than the newest menu we have (a park still linking a 2024
    // sheet after we photographed 2026 boards), or more than a year old, is
    // history: file it under the day the PDF was made, so it neither stands in
    // front of newer prices nor passes for today's.
    const madeOn = got.map((g) => made(g.file)).filter(Boolean).sort().at(-1) ?? null;
    // A prev read from an earlier PDF is dated by its fetch, not its file, and
    // the park replacing that PDF makes this one the newer menu.
    const older = !!(madeOn && ((prev && !prev.source?.sha256 && madeOn < prev.date) || madeOn < YEAR_AGO));
    plan.push({
      park: key,
      source: park,
      venue: path.relative(MENUS, dir),
      name: poi.display ?? poi.name,
      urls,
      sha256,
      // Several PDFs: each one's own hash, for source.files.
      ...(got.length > 1 ? { files: got.map((g, i) => ({ url: urls[i], sha256: g.sha256 })) } : {}),
      pdfs: got.map((g) => g.file),
      made: madeOn,
      out: path.relative(MENUS, path.join(dir, older ? madeOn : TODAY, "menu.json")),
      // Dated by the file, not a fetch: the menu.json gets approxDate: true.
      ...(older ? { older: true } : {}),
      changed: !!prev,
    });
    console.log(`${older ? "< older  " : prev ? "~ changed" : "+ new    "} ${path.relative(MENUS, dir)}`);
  }
}
saveLedger();
writeJson(PLAN, plan);
console.log(`${plan.length} menus to transcribe; plan in ${path.relative(process.cwd(), PLAN)}`);

// Snapshot the pages just read and ask the public archives for copies.
await archivePages();
