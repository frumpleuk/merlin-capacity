// Name the "Ride NNNNN" lines: queue lines whose ride the park's current app
// bundle no longer carries (a ride dropped from the app for a season, a maze
// renamed, a soft launch). Every bundle a park ever published is in a public,
// listable S3 bucket, so look each missing ride up in older bundles, newest
// first, and record the last name it had in src/past-names.json, which the
// catalog build falls back on (src/rides.ts).
//
//   node scripts/past-names.mjs [park_key...]   (default: every Attractions.io park)
//
// Reads the live catalogs from the site, so run it after the parks are deployed.
// One bundle per month is read, back to MAX_MONTHS; only records.json is
// inflated from each. Local only: this is far too heavy for the Worker's cron.
import fs from "node:fs";
import path from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { attractionsParks } from "../src/config.ts";
import { REPO } from "./menus/lib.mjs";

const SITE = "https://themeparks.frumple.co.uk";
const BUCKET = "https://s3-eu-west-1.amazonaws.com/attractions-io-production-app-data-bundles";
const OUT = path.join(REPO, "src/past-names.json");
const MAX_MONTHS = 48;

const text = (n) =>
  n && typeof n === "object" ? n["en-GB"] ?? n["en-US"] ?? n.en ?? Object.values(n)[0] : n;
/** Mirrors the catalog build's tidy-up (src/rides.ts `cleanName`). */
const clean = (s) =>
  s
    .replace(/^[①-⓿❶-➓㉑-㉟㊱-㊿]\s*/u, "")
    .replace(/^NEW FOR \d{4}\s*[-–:]\s*/i, "")
    .trim();

/** Every bundle key for a slug, oldest first (the listing pages at 1000). */
async function bundleKeys(slug) {
  const keys = [];
  let after = "";
  for (;;) {
    const url = `${BUCKET}?list-type=2&prefix=app-data/${slug}/versions/${after ? `&start-after=${encodeURIComponent(after)}` : ""}`;
    const xml = await (await fetch(url)).text();
    const page = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    keys.push(...page);
    if (!xml.includes("<IsTruncated>true") || !page.length) return keys;
    after = page.at(-1);
  }
}

/** records.json from one bundle, streamed so the media is never held. */
async function records(key) {
  const resp = await fetch(`${BUCKET}/${key}`);
  if (!resp.ok || !resp.body) return null;
  const parts = [];
  let done;
  const finished = new Promise((r) => (done = r));
  const unz = new Unzip();
  unz.register(UnzipInflate);
  unz.onfile = (f) => {
    if (f.name !== "records.json") return;
    f.ondata = (err, chunk, last) => {
      if (err) throw err;
      parts.push(chunk);
      if (last) done();
    };
    f.start();
  };
  const reader = resp.body.getReader();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) {
      unz.push(new Uint8Array(0), true);
      break;
    }
    unz.push(value, false);
  }
  await Promise.race([finished, new Promise((r) => setTimeout(r, 5000))]);
  if (!parts.length) return null;
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const wanted = process.argv.slice(2);

for (const park of attractionsParks()) {
  if (wanted.length && !wanted.includes(park.key)) continue;
  const cat = await (await fetch(`${SITE}/queues/${park.key}/catalog.json?x=${Date.now()}`)).json().catch(() => null);
  if (!cat) {
    console.log(`${park.key}: no catalog on the site yet`);
    continue;
  }
  const known = out[park.key] ?? {};
  const missing = new Set(
    Object.values(cat.queueLines)
      .map((q) => q.item)
      .filter((id) => !cat.items[String(id)] && !known[String(id)]),
  );
  if (!missing.size) {
    console.log(`${park.key}: nothing to name`);
    continue;
  }
  console.log(`${park.key}: looking for ${[...missing].join(", ")}`);

  // One bundle per month, newest first.
  const byMonth = new Map();
  for (const k of await bundleKeys(park.queue.slug)) byMonth.set(k.split("/").pop().slice(0, 7), k);
  const months = [...byMonth.keys()].sort().reverse().slice(0, MAX_MONTHS);
  for (const month of months) {
    if (!missing.size) break;
    const r = await records(byMonth.get(month));
    for (const item of r?.Item ?? []) {
      const name = text(item.Name);
      if (!missing.has(item._id) || !name) continue;
      known[String(item._id)] = { name: clean(name), seen: month };
      missing.delete(item._id);
      console.log(`  ${item._id} = ${clean(name)} (${month})`);
    }
  }
  if (missing.size) console.log(`  never named in ${months.length} months: ${[...missing].join(", ")}`);
  if (Object.keys(known).length) out[park.key] = known;
}

const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`wrote ${path.relative(REPO, OUT)}`);
