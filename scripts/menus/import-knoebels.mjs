// Import Knoebels' own menus, with prices, from its website.
//
//   node scripts/menus/import-knoebels.mjs
//
// Every stand has a page at knoebels.com/menu/<slug>/ (the venue's
// displayMenuUrl; the app's /dine/ links are dead), rendered by the "Five Star
// Food and Drink Menu" WordPress plugin: `ul.fdm-section` per section, its
// `h3` the heading, then one `li.fdm-item` per dish with `h4.fdm-item-title`,
// an optional `p.fdm-item-content` and `div.fdm-item-price`. The same data is
// in the site's REST API (wp-json/wp/v2/fdm-menu-item), but that loses the
// order of dishes within a section, so the pages are read instead.
//
// Prices are USD, written as integer cents. A price string carries sizes two
// ways: "6/$9.25;12/$15.25" (label/price pairs) and "$3.00/$4.00" (labels in
// the description, "Small 16 oz./Large 24 oz.").
//
// The seasonal Hall-O-Fun menus (hallo-fun-<slug>) replace the regular ones on
// event weekends and aren't read. robots.txt asks for 10 seconds between
// requests; every page is cached under the system temp dir. A menu whose dishes
// haven't changed since the last import isn't written again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archivePages } from "./archive-pages.mjs";
import { DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "knoebels-menu-cache");
const TODAY = new Date().toISOString().slice(0, 10);
const MENU_URL = /^https:\/\/knoebels\.com\/menu\/[\w-]+\/$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${TODAY}-${slug(url.replace(/^https?:\/\//, ""))}.html`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const resp = await fetch(url, { headers: { "user-agent": UA } });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  const html = await resp.text();
  fs.writeFileSync(file, html);
  await sleep(10_000);
  return html;
}

const strip = (html) =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const cents = (s) => {
  const m = s.match(/^\$(\d+)(?:\.(\d\d))?$/);
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : null;
};

/** One dish from its name, description and price string. */
function item(name, description, priceText) {
  const out = { name, ...(description ? { description } : {}) };
  const one = cents(priceText);
  if (one != null) return { ...out, price: one };
  // "6/$9.25;12/$15.25"
  const pairs = priceText.split(";").map((p) => p.match(/^([^$][^/]*)\/(\$[\d.]+)$/));
  if (pairs.every(Boolean)) {
    return { ...out, sizes: pairs.map(([, label, p]) => ({ label: label.trim(), price: cents(p) })) };
  }
  // "$3.00/$4.00" with "Small 16 oz./Large 24 oz." as the description.
  const prices = priceText.split("/").map(cents);
  const labels = (description ?? "").split("/").map((l) => l.trim().replace(/\.$/, ""));
  if (prices.every((p) => p != null) && labels.length === prices.length && labels.every(Boolean)) {
    return { name, sizes: prices.map((price, i) => ({ label: labels[i], price })) };
  }
  return { ...out, price: null, unclear: `price printed as "${priceText}"` };
}

function parseMenu(html) {
  const sections = [];
  for (const sec of html.split(/<ul class="fdm-section\b/).slice(1)) {
    const name = strip(sec.match(/<li class="fdm-section-header"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const items = [];
    for (const it of sec.split(/<li class="fdm-item\b/).slice(1)) {
      const title = strip(it.match(/<h4 class="fdm-item-title"[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? "");
      if (!title) continue;
      const desc = strip(it.match(/<p class="fdm-item-content"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
      const price = strip(it.match(/<div class="fdm-item-price"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
      items.push(item(title, desc, price));
    }
    if (items.length) sections.push({ name: name || "Menu", items });
  }
  return sections;
}

/** The newest menu already imported from the site, if any. */
function previous(venueDir) {
  const dates = fs
    .readdirSync(venueDir)
    .filter((d) => DATE_DIR.test(d) && fs.existsSync(path.join(venueDir, d, "menu.json")))
    .sort()
    .reverse();
  for (const d of dates) {
    const m = readJson(path.join(venueDir, d, "menu.json"));
    if (MENU_URL.test(m.source?.url ?? "")) return m;
  }
  return null;
}

let written = 0;
let unchanged = 0;
let empty = 0;
for (const v of venues(parkDir("knoebels"))) {
  if (v.poi.appMissingSince || v.poi.goneSince) continue;
  const url = v.poi.displayMenuUrl ?? v.poi.menuUrl ?? "";
  if (!MENU_URL.test(url)) continue;
  let sections;
  try {
    sections = parseMenu(await page(url));
  } catch (e) {
    console.warn(`! ${path.relative(MENUS, v.dir)}: ${e.message}`);
    continue;
  }
  const items = sections.reduce((n, s) => n + s.items.length, 0);
  if (!items) {
    empty++;
    console.log(`- ${path.relative(MENUS, v.dir)}: no dishes on ${url}`);
    continue;
  }
  const before = previous(v.dir);
  if (before && JSON.stringify(before.sections) === JSON.stringify(sections)) {
    unchanged++;
    continue;
  }
  const dir = path.join(v.dir, TODAY);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "menu.json"), {
    date: TODAY,
    source: { name: "Knoebels", official: true, url },
    sections,
  });
  written++;
  console.log(`+ ${path.relative(MENUS, dir)}/menu.json  (${items} dishes, ${sections.length} sections)`);
}
console.log(`knoebels: ${written} written, ${unchanged} unchanged, ${empty} with nothing published`);

// Snapshot the pages just read and ask the public archives for copies.
await archivePages();
