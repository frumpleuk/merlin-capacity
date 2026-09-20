// Upload the committed web/*.jpg menu photos to R2, where the worker serves
// them from /menus/... (see src/index.ts). Keys are immutable, so this only
// uploads what isn't there yet: it HEADs each key on the live site first and
// skips the ones that answer 200. Runs after `npm run deploy`.
//
//   node scripts/menus/publish.mjs [--force] [--dry-run]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PARK_DIRS, REPO, ROOT } from "./lib.mjs";

// This one runs in CI (the Cloudflare deploy command), where the Node version
// isn't ours to pick — so read the origin out of src/config.ts rather than
// importing it, which would need Node's TypeScript stripping.
const SITE_ORIGIN =
  process.env.SITE_ORIGIN ??
  fs.readFileSync(path.join(REPO, "src/config.ts"), "utf8").match(/SITE_ORIGIN\s*=\s*"([^"]+)"/)?.[1];
if (!SITE_ORIGIN) throw new Error("no SITE_ORIGIN in src/config.ts and none in the environment");

const BUCKET = "merlin-capacity"; // matches wrangler.toml's r2_buckets entry
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

/** Every committed web JPEG, as { file, key } with the key it takes in R2. */
function webPhotos() {
  const out = [];
  const parkDirs = new Set(Object.values(PARK_DIRS));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === "web") {
        for (const f of fs.readdirSync(p)) {
          if (f.endsWith(".jpg")) out.push({ file: path.join(p, f), key: `menus/${path.relative(ROOT, path.join(p, f)).replace("/web/", "/")}` });
        }
      } else walk(p);
    }
  };
  for (const park of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (park.isDirectory() && parkDirs.has(park.name)) walk(path.join(ROOT, park.name));
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const photos = webPhotos();
if (!photos.length) {
  console.log("no web photos yet — run scripts/menus/optimise.mjs");
  process.exit(0);
}

// HEAD in parallel; a 404 (or any non-200) means it still needs uploading.
const present = new Set();
if (!force) {
  await Promise.all(
    photos.map(async ({ key }) => {
      try {
        const r = await fetch(`${SITE_ORIGIN}/${key}`, { method: "HEAD" });
        if (r.ok) present.add(key);
      } catch {
        /* offline or not deployed yet: treat as missing */
      }
    }),
  );
}

const todo = photos.filter((p) => !present.has(p.key));
console.log(`${photos.length} photos, ${present.size} already on R2, ${todo.length} to upload`);
for (const { file, key } of todo) {
  if (dryRun) {
    console.log(`would upload ${key}`);
    continue;
  }
  execFileSync(
    "npx",
    // No --remote: `r2 object put` writes to the real bucket by default, and
    // the flag it does take is --local. Passing an unknown flag fails the CLI.
    ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", "image/jpeg"],
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  );
  console.log(`uploaded ${key}`);
}
