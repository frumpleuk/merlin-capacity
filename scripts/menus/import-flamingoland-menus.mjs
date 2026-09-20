// Import Flamingo Land's own menus, which the park publishes on its website as
// a "food-and-drink-menu" post type, listed in its own sitemap.
//
//   node scripts/menus/import-flamingoland-menus.mjs
//
// These are the one menu source for the park that carries PRICES, and calories
// and dietary marks with them (the app's Firestore has venue descriptions but
// no dishes, and Theme Park James's three Flamingo Land menus are from 2023).
// Only a couple of venues are published this way today; the sitemap is read
// each run, so anything the park adds later is picked up without a code change.
//
// A venue with both a food and a drinks page gets one menu: they're the same
// boards on the same day, so the sections are merged in that order.
//
// Fetching is one page a second with a named user agent and a cache. An
// unchanged menu isn't written again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const PARK = "flamingoland";
const CREDIT = "Flamingo Land";
const SITEMAP = "https://www.flamingoland.co.uk/food-and-drink-menu-sitemap.xml";
const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "flamingoland-menu-cache");
const TODAY = new Date().toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, slug(url.replace(/^https?:\/\//, "")) + ".html");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
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
    .replace(/&pound;/g, "£")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Sections that are drink lists: their items get the alcohol tag (the page
 *  prints an ABV column for exactly these). */
const ALCOHOL = /gin|vodka|brandy|rum|whisk|liqu|spirit|wine|champagne|prosecco|beer|cider|cocktail/i;

/** The park's allergen marks, as the item's link class spells them. */
const TAGS = { ve: "vg", v: "v", gf: "gf", df: "df" };

const pence = (s) => {
  const m = strip(s).match(/£\s*(\d+)(?:\.(\d{2}))?/);
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : null;
};

/**
 * The park publishes two shapes of page and this reads both.
 *
 * A food page is a list of dishes: `.item_title`, an optional `.item_description`
 * and `.item_additions`, `.kcal`, and one `.item_price`.
 *
 * A drinks page is a table: the section heading names the columns ("kcals per
 * 100ml", "ABV", "25ml", "Double") and each row carries a value per column. A
 * column whose values are prices is a serving size, so a gin becomes one item
 * with a 25ml price and a double price; ABV is recorded as part of what the
 * board says about the drink.
 */
function parseMenu(html) {
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
  const sections = [];
  for (const block of body.split(/<div class="row section/).slice(1)) {
    const name = strip((block.match(/<h2 class="section_title"[^>]*>([\s\S]*?)<\/h2>/) ?? [, ""])[1]);
    if (!name) continue;
    // "kcals per 100ml", "ABV", "25ml", "Double" — only a drinks table has them.
    const labels = {};
    const heading = block.match(/<div class="section_heading">([\s\S]*?)<div class="item/);
    for (const col of (heading?.[1] ?? "").matchAll(/<div class="col(\d)"[^>]*>([\s\S]*?)<\/div>/g)) {
      const label = strip(col[2]);
      if (label) labels[col[1]] = label;
    }
    const drink = ALCOHOL.test(name) && !/free/i.test(name);

    const items = [];
    for (const row of block.split(/<div class="item\s*"/).slice(1)) {
      const title = strip((row.match(/class="item_title"[^>]*>([\s\S]*?)<\/span>/) ?? [, ""])[1]).replace(/[,:]$/, "");
      if (!title) continue;
      const desc = strip((row.match(/class="item_description"[^>]*>([\s\S]*?)<\/span>/) ?? [, ""])[1]);
      // "Add bacon £1.50" is what the board says about the dish, not a dish.
      const adds = strip((row.match(/class="item_additions"[^>]*>([\s\S]*?)<\/span>/) ?? [, ""])[1]);
      const tags = [
        ...new Set([
          ...[...row.matchAll(/class="allergen ([A-Za-z]+)"/g)].map((t) => TAGS[t[1].toLowerCase()]).filter(Boolean),
          ...(drink ? ["alcohol"] : []),
        ]),
      ];
      let kcal = strip(row.match(/class="kcal"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "").match(/([\d,]+)\s*kcal/i)?.[1];
      let price = pence(row.match(/class="item_price"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
      const sizes = [];
      const extra = [];
      for (const col of row.matchAll(/<span class="column(\d)"[^>]*>([\s\S]*?)<\/span>/g)) {
        const label = labels[col[1]] ?? "";
        const value = strip(col[2]);
        if (!value) continue;
        // "kcals per 100ml" is not the drink's calories, so it stays a note.
        if (/kcal/i.test(label) && !/per/i.test(label)) kcal ??= value.match(/([\d,]+)/)?.[1];
        else if (/^£/.test(value)) {
          const p = pence(value);
          if (p) sizes.push({ label: label || "Price", price: p }); // £0.00 = no such size
        } else if (/kcals? per (.+)/i.test(label)) extra.push(`${value} kcal per ${label.match(/per (.+)/i)[1]}`);
        else if (label) extra.push(`${label} ${value}`);
      }
      // One unnamed price column is just the price.
      if (price == null && sizes.length === 1 && sizes[0].label === "Price") price = sizes.pop().price;
      const description = [desc, adds, ...extra].filter(Boolean).join(" ");
      items.push({
        name: title,
        ...(description ? { description } : {}),
        ...(sizes.length ? { sizes } : { price }),
        ...(kcal ? { kcal: Number(String(kcal).replace(/,/g, "")) } : {}),
        ...(tags.length ? { tags } : {}),
        ...(!sizes.length && price == null ? { unclear: "the page prints no price for this one" } : {}),
      });
    }
    if (items.length) sections.push({ name, items });
  }
  return sections;
}

/** Which venue folder a menu page belongs to: its slug without the menu
 *  suffix, else the folder whose name shares the most words. */
function venueFor(all, url) {
  const name = url.replace(/\/$/, "").split("/").pop();
  const bare = name.replace(/-(food|drinks?)?-?menu$/, "");
  const exact = all.find((v) => path.basename(v.dir) === bare);
  if (exact) return exact;
  const words = new Set(bare.split("-").filter((w) => w.length > 2));
  let best = null;
  for (const v of all) {
    const theirs = new Set(slug(v.poi.name ?? "").split("-"));
    const shared = [...words].filter((w) => theirs.has(w)).length;
    const score = shared / Math.max(1, Math.min(words.size, theirs.size));
    if (score >= 0.5 && (!best || score > best.score)) best = { v, score };
  }
  return best?.v ?? null;
}

const all = venues(parkDir(PARK));
const urls = [...(await page(SITEMAP)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
// A food page before its drinks page, so the merged menu reads in that order.
urls.sort((a, b) => Number(/drinks/.test(a)) - Number(/drinks/.test(b)) || a.localeCompare(b));

const byVenue = new Map();
for (const url of urls) {
  const v = venueFor(all, url);
  if (!v) {
    console.warn(`! no venue folder for ${url}`);
    continue;
  }
  const sections = parseMenu(await page(url));
  if (!sections.length) {
    console.log(`- ${url}: nothing to read`);
    continue;
  }
  const got = byVenue.get(v.dir) ?? { v, url, sections: [] };
  got.sections.push(...sections);
  byVenue.set(v.dir, got);
}

let written = 0;
let unchanged = 0;
for (const { v, url, sections } of byVenue.values()) {
  const items = sections.reduce((n, s) => n + s.items.length, 0);
  const existing = fs
    .readdirSync(v.dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATE_DIR.test(e.name))
    .map((e) => path.join(v.dir, e.name, "menu.json"))
    .filter((f) => fs.existsSync(f))
    .map(readJson)
    .find((m) => m.source?.url === url);
  if (existing && JSON.stringify(existing.sections) === JSON.stringify(sections)) {
    unchanged++;
    continue;
  }
  const dir = path.join(v.dir, TODAY);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "menu.json"), {
    date: TODAY,
    source: { name: CREDIT, official: true, url },
    sections,
  });
  // The app gives Flamingo Land venues no menu link, so this is the one the
  // Food tab can offer as "Official menu".
  if (!v.poi.menuUrl) writeJson(path.join(v.dir, "poi.json"), { ...v.poi, menuUrl: url });
  written++;
  console.log(`+ ${path.relative(MENUS, dir)}/menu.json  (${items} dishes, ${sections.length} sections)`);
}
console.log(`${PARK}: ${written} written, ${unchanged} unchanged`);
