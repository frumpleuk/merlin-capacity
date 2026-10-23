// Archive the source behind every official PDF menu already transcribed, for
// menus taken before the archive existed (import-pdf-menus.mjs archives new
// ones as it fetches them).
//
//   node scripts/menus/archive-sources.mjs
//
// For each menu.json whose source is an official PDF, fetch the file(s) again.
// If the hash still matches the one the menu recorded, the copy goes to the
// private archive (archive-lib.mjs). A menu read from several PDFs gets its
// `source.files` written. If the hash no longer matches, the park has changed
// or removed the file since: that original is lost, and it is listed so.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archive, isArchived, saveLedger } from "./archive-lib.mjs";
import { ALL_PARK_DIRS, DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "park-menu-pdfs");
const DAY = 86_400_000;
const isPdf = (url) => /\.pdf(?:[?#]|$)/i.test(url ?? "");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The file at `url`: today's copy from import-pdf-menus's cache if there is
 *  one, else a fresh download. Null when the park no longer serves it. */
const seen = new Map();
async function get(url) {
  if (seen.has(url)) return seen.get(url);
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, slug(url.replace(/^https?:\/\//, "")) + ".pdf");
  let got = null;
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < DAY) {
    got = { file, sha256: sha(fs.readFileSync(file)) };
  } else {
    const resp = await fetch(url, { headers: { "user-agent": UA } }).catch(() => null);
    if (resp?.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(file, buf);
      got = { file, sha256: sha(buf) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  seen.set(url, got);
  return got;
}

const today = new Date().toISOString().slice(0, 10);
const lost = [];
let kept = 0;
let already = 0;
for (const key of Object.keys(ALL_PARK_DIRS)) {
  if (!fs.existsSync(parkDir(key))) continue;
  for (const { dir, poi } of venues(parkDir(key))) {
    for (const d of fs.readdirSync(dir).filter((d) => DATE_DIR.test(d)).sort()) {
      const mf = path.join(dir, d, "menu.json");
      if (!fs.existsSync(mf)) continue;
      const menu = readJson(mf);
      const src = menu.source;
      if (!src?.official || !src.sha256 || !isPdf(src.url)) continue;
      const parts = src.files ?? [{ url: src.url, sha256: src.sha256 }];
      if (parts.every((p) => isArchived(p.sha256))) {
        already++;
        continue;
      }
      const where = path.relative(MENUS, mf);
      // A single PDF: its own hash. Several (the venue's menuPdfs, in order):
      // the hash of their hashes.
      const one = await get(src.url);
      if (one?.sha256 === src.sha256) {
        archive({ file: one.file, sha256: one.sha256, url: src.url, fetched: today });
        kept++;
        continue;
      }
      const urls = poi.menuPdfs?.[0] === src.url ? poi.menuPdfs : null;
      if (urls) {
        const got = [];
        for (const u of urls) got.push(await get(u));
        const combined = got.every(Boolean) ? sha(got.map((g) => g.sha256).join("\n")) : null;
        if (combined === src.sha256) {
          got.forEach((g, i) => archive({ file: g.file, sha256: g.sha256, url: urls[i], fetched: today }));
          menu.source.files = got.map((g, i) => ({ url: urls[i], sha256: g.sha256 }));
          writeJson(mf, menu);
          kept++;
          continue;
        }
      }
      lost.push(`${where}: ${one ? "the park's file has changed since" : "the park no longer serves it"}`);
    }
  }
}
saveLedger();
console.log(`${kept} archived, ${already} already archived, ${lost.length} lost:`);
for (const l of lost) console.log(`  ${l}`);
