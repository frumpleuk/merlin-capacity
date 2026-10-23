// Import the dishes Legoland Japan's website shows for each restaurant, with
// their yen prices.
//
//   node scripts/menus/import-legoland-japan.mjs
//
// Each restaurant has an English page at
// legoland.jp/en/resort-guide/legoland/food/<slug>/ (the venue's
// displayMenuUrl) whose "Recommended Menus" are its featured dishes, not the
// whole board. The CMS lays them out two ways, an image-with-text row
// (`#imageWithTextStack .rich-text`) or a gallery card
// (`.four-column-gallery-block__content`); in either block the heading holding
// a yen sign is the price and the first other heading the dish, with any text
// after a <br> or in <small> its description. Prices are tax included, whole
// yen.
//
// One page a second; pages are cached under the system temp dir for the day. A
// menu whose dishes haven't changed since the last import isn't written again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archivePages } from "./archive-pages.mjs";
import { DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const CACHE = path.join(os.tmpdir(), "legoland-japan-cache");
const TODAY = new Date().toISOString().slice(0, 10);
const PAGE = /^https:\/\/www\.legoland\.jp\/en\/resort-guide\/legoland\/food\/[\w-]+\/$/;
const YEN = /[¥￥円]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${TODAY}-${slug(url.replace(/^https?:\/\//, ""))}.html`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  // The site refuses an unknown agent, so ask as a browser would.
  const resp = await fetch(url, { headers: { "user-agent": UA } });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  const html = await resp.text();
  fs.writeFileSync(file, html);
  await sleep(1000);
  return html;
}

const strip = (html) =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const yen = (s) => {
  const m = s.match(/^[¥￥]\s*([\d,]+)(?:\s*円)?(?:\s*each)?$/i) ?? s.match(/^([\d,]+)\s*円$/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

/** A dish from its name, description and price text. */
function item(name, description, priceText) {
  const out = { name, ...(description ? { description } : {}) };
  const one = yen(priceText);
  if (one != null) return { ...out, price: one };
  const parts = priceText.split(/\s*[/／]\s*/);
  // "5 pieces ¥500／10 pieces ¥900"
  const pairs = parts.map((p) => p.match(/^(.*?\S)\s*([¥￥][\d,]+)$/));
  if (pairs.every(Boolean)) return { ...out, sizes: pairs.map(([, label, p]) => ({ label, price: yen(p) })) };
  // "¥500/¥700/¥850" with the sizes named in the description.
  const prices = parts.map(yen);
  const labels = (description ?? "").split(/\s*[/／]\s*/);
  if (prices.every((p) => p != null) && labels.length === prices.length && labels.every(Boolean)) {
    return { name, sizes: prices.map((price, i) => ({ label: labels[i], price })) };
  }
  return { ...out, price: null, unclear: `price printed as "${priceText}"` };
}

function parseMenu(html) {
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
  const starts = [...body.matchAll(/id="imageWithTextStack"|class="four-column-gallery-block__content\b/g)].map((m) => m.index);
  const sections = [{ name: "Recommended Menus", items: [] }];
  for (const [i, at] of starts.entries()) {
    const block = body.slice(at, starts[i + 1] ?? at + 6000);
    const heads = [...block.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => m[2]);
    const priceAt = heads.findIndex((h) => YEN.test(strip(h)));
    if (priceAt < 0) continue;
    const nameHtml = heads.find((h, j) => j !== priceAt && strip(h) && !YEN.test(strip(h)));
    if (!nameHtml) continue;
    // "Name<br><small>Includes a soft drink</small>": the first line is the dish.
    const [first, ...rest] = nameHtml.split(/<br\s*\/?>/i);
    let name = strip(first);
    let description = strip(rest.join(" "));
    // "2 Piece Chicken Set/<br>4 Piece Chicken Set": one dish name per price.
    if (name.endsWith("/")) {
      name = `${name.slice(0, -1).trim()} / ${description}`;
      description = name;
    }
    if (name) {
      const section = sections.at(-1);
      const dish = item(name, description, strip(heads[priceAt]));
      // Knight's Table's toppings go on its curries.
      if (/topping/i.test(section.name)) dish.addOn = true;
      section.items.push(dish);
    }
    // A heading after the price is the next group's title ("Various Toppings").
    const next = heads.slice(priceAt + 1).map(strip).find((h) => h && !YEN.test(h));
    if (next) sections.push({ name: next, items: [] });
  }
  return sections.filter((s) => s.items.length);
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
    if (PAGE.test(m.source?.url ?? "")) return m;
  }
  return null;
}

let written = 0;
let unchanged = 0;
let empty = 0;
for (const v of venues(parkDir("legoland_japan"))) {
  if (v.poi.appMissingSince || v.poi.goneSince) continue;
  const url = v.poi.displayMenuUrl ?? v.poi.menuUrl ?? "";
  if (!PAGE.test(url)) continue;
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
    source: { name: "Legoland Japan", official: true, url },
    sections,
  });
  written++;
  console.log(`+ ${path.relative(MENUS, dir)}/menu.json  (${items} dishes)`);
}
console.log(`legoland_japan: ${written} written, ${unchanged} unchanged, ${empty} with nothing published`);

// Snapshot the pages just read. The public copies are slow (the Wayback
// Machine takes a few a minute), so they're left to archive-pages.mjs, run on
// its own in the background.
await archivePages({ publicCopies: false });
