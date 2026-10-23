// The provenance archive: a private copy of every source file a menu was read
// from (a park's PDF), kept in R2 under archive/menus/<sha256>.<ext>. The
// worker never serves that prefix (src/index.ts serves only named prefixes), so
// the parks' own artwork isn't republished; it's evidence for us when the
// park's link dies or the file behind it changes.
//
// contrib/menus/archive.json is the committed ledger: one entry per file, keyed
// by its sha256, saying where it came from, when, and where the copy is. A
// menu.json `source.sha256` (or each of `source.files`) looks up here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MENUS, REPO, readJson, writeJson } from "./lib.mjs";

const BUCKET = "merlin-capacity"; // matches wrangler.toml's r2_buckets entry
export const LEDGER = path.join(MENUS, "archive.json");

const ledger = fs.existsSync(LEDGER) ? readJson(LEDGER) : {};

export const isArchived = (sha256) => !!ledger[sha256];

const EXT = { "application/pdf": "pdf", "text/html": "html", "image/jpeg": "jpg", "image/png": "png" };

/** Copy one fetched file to the private archive, once per hash, and record it.
 *  Returns the ledger entry. Throws if the upload fails, so nothing is recorded
 *  that isn't there. */
export function archive({ file, sha256, url, type = "application/pdf", fetched }) {
  if (ledger[sha256]) return ledger[sha256];
  const key = `archive/menus/${sha256}.${EXT[type] ?? "bin"}`;
  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", type, "--remote"],
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  );
  ledger[sha256] = { url, fetched, bytes: fs.statSync(file).size, type, key };
  return ledger[sha256];
}

/** Write the ledger, sorted so diffs stay small. */
export function saveLedger() {
  writeJson(LEDGER, Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b))));
}
