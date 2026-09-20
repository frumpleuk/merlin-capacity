// Import Blackpool Pleasure Beach's own menus from the park's website, which
// is where each venue's app marker (`menuUrl` in poi.json) points.
//
//   node scripts/menus/import-bpb-menus.mjs
//
// Each "<venue>-menu" page lists the dishes under FOOD / DRINKS / KIDS MENU
// headings, with a description after an en dash, and says in the intro whether
// a Season Pass gets money off there. It prints no prices anywhere, so these
// menus are written with `unpriced: true`, like Paulton's Tenkites boards
// (import-tenkites.mjs). Theme Park James has no Blackpool food pages, so this
// is the only dish list the park has published.
//
// Fetching is one page a second with a named user agent and a cache, so a
// re-run costs the park nothing. An unchanged menu isn't written again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const PARK = "blackpool";
const CREDIT = "Pleasure Beach Resort";
const HOSTS = /blackpoolpleasurebeach\.com/;
const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "bpb-menu-cache");
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Words the park writes in capitals because that's what they are, not because
 *  the whole board is shouting. */
const KEEP_CAPS = new Set(["BBQ", "FY4", "VIP", "UK", "XL", "BLT", "PBR", "IPA"]);
const SMALL = new Set(["a", "an", "and", "the", "of", "with", "in", "on", "or", "to"]);

/** Mostly capitals: the usual way a dish is typed on these pages. Measurements
 *  ("4oz") and marks ("(vegan)") carry lowercase, so this weighs how much of
 *  the line is lower case rather than asking whether any of it is. */
function shouts(s) {
  const letters = s.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters.replace(/[^a-z]/g, "").length / letters.length < 0.3;
}

/** A short capitalised phrase: the other way ("Hot Drinks", "Bucket of Fries").
 *  A note is a sentence, so it runs longer or starts lower case. */
function titleish(s) {
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6 || !/^[A-Z0-9]/.test(s)) return false;
  return words.every((w) => !/[A-Za-z]/.test(w) || /^[A-Z]/.test(w) || SMALL.has(w.toLowerCase().replace(/[^a-z]/g, "")));
}

/** What the park sells, as against what it says about it. */
const isDish = (s) => shouts(s) || titleish(s);

/** The pages are typed in capitals; the dish is the same either way, so this
 *  fixes the capitalisation and nothing else. */
function titleCase(s) {
  if (!shouts(s)) return s; // written in sentence case: leave it alone
  return s
    .split(/(\s+|\/)/)
    .map((w, i) => {
      const bare = w.replace(/[^a-z0-9']/gi, "");
      if (!bare) return w;
      if (/\d/.test(bare)) return w; // "4oz", "FY4": as printed
      if (KEEP_CAPS.has(bare.toUpperCase())) return w.toUpperCase();
      const lower = w.toLowerCase();
      if (i > 0 && SMALL.has(bare.toLowerCase())) return lower;
      return lower.replace(/[a-z]/, (c) => c.toUpperCase());
    })
    .join("");
}

const TAGS = [
  [/\((vegan|vg|ve)\)/i, "vg"],
  [/\((vegetarian|v)\)/i, "v"],
  [/\((gluten[- ]free|gf)\)/i, "gf"],
  [/\((dairy[- ]free|df)\)/i, "df"],
];

/** Headings that are on every page and are not part of a menu. */
const NOT_A_SECTION = /^(WELCOME TO\b|SPECIAL FEATURES$|ALLERGEN INFORMATION$|OUR LOCATION$|NEW$)/i;

/**
 * The pages are Elementor: an `<h2 class="elementor-heading-title">` opens a
 * section and the text-editor widget after it holds one `<p>` per line. A line
 * is a dish when it's in capitals ("THE ICONIC - A 4oz beef burger…").
 *
 * A sentence-case line is either the dish above's description (some pages put
 * the name and its description in two paragraphs instead of splitting one on a
 * dash) or a note on the section ("A meal includes a portion of fries"). Which
 * one it is follows from the dish above: if that dish already has its
 * description, this line is a note.
 */
function parseMenu(html) {
  // The footer is headings and paragraphs like everything else ("Get in touch",
  // the phone number, the address), so the menu ends where it begins.
  const body = html.split(/<footer[\s>]/)[0].replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
  const sections = [];
  let current = null;
  const token = /<h2 class="elementor-heading-title[^"]*">([\s\S]*?)<\/h2>|<p>([\s\S]*?)<\/p>/g;
  for (const m of body.matchAll(token)) {
    if (m[1] !== undefined) {
      const name = strip(m[1]);
      // Menu headings are in capitals; the nav and footer headings aren't.
      current = name && shouts(name) && !NOT_A_SECTION.test(name) ? { name: titleCase(name), items: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current) continue;
    // One paragraph can hold several dishes, a line break between each.
    for (const raw of m[2].split(/<br\s*\/?>/i)) {
      const line = strip(raw);
      if (!line) continue;
      const [, head, desc = ""] = line.match(/^(.*?)\s+[-–—]\s+(.*)$/) ?? [, line];
      if (!isDish(head)) {
        const above = current.items[current.items.length - 1];
        if (above && !above.description) above.description = line;
        else current.note = current.note ? `${current.note} ${line}` : line;
        continue;
      }
      const tags = TAGS.filter(([re]) => re.test(head) || re.test(desc)).map(([, t]) => t);
      // Some boards print the calories after the dish: "Tuna & Coleslaw, 1031 Kcal".
      const kcal = head.match(/,?\s*([\d,]+)\s*kcal\s*$/i);
      current.items.push({
        name: titleCase(
          head
            .replace(/,?\s*[\d,]+\s*kcal\s*$/i, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .replace(/,$/, "")
            .trim(),
        ),
        ...(desc ? { description: desc.charAt(0).toUpperCase() + desc.slice(1) } : {}),
        price: null,
        ...(kcal ? { kcal: Number(kcal[1].replace(/,/g, "")) } : {}),
        ...(tags.length ? { tags: [...new Set(tags)] } : {}),
      });
    }
  }
  return sections.filter((s) => s.items.length);
}

/** The intro's feature list says whether a Season Pass gets money off here.
 *  Absence isn't a "no" (not every page lists its features), so only a stated
 *  discount is recorded. */
const passDiscount = (html) =>
  /Season Pass discounts?\s*<\/li>/i.test(html)
    ? { offered: true, percent: null, applies: "Season Pass", source: "park website" }
    : null;

/** The newest menu already imported from this page, if any. */
function previous(venueDir, url) {
  const dates = fs
    .readdirSync(venueDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATE_DIR.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dates) {
    const file = path.join(venueDir, d, "menu.json");
    if (fs.existsSync(file) && readJson(file).source?.url === url) return readJson(file);
  }
  return null;
}

let written = 0;
let unchanged = 0;
let empty = 0;
let passes = 0;
for (const v of venues(parkDir(PARK))) {
  const url = v.poi.menuUrl ?? "";
  if (!HOSTS.test(url)) continue; // a venue's own site (White Tower, the hotels)
  const html = await page(url);
  const sections = parseMenu(html);
  const items = sections.reduce((n, s) => n + s.items.length, 0);

  const pass = passDiscount(html);
  if (pass && !v.poi.passDiscount) {
    writeJson(path.join(v.dir, "poi.json"), { ...v.poi, passDiscount: pass });
    passes++;
  }
  if (!items) {
    empty++;
    console.log(`- ${path.relative(MENUS, v.dir)}: no dishes listed on ${url}`);
    continue;
  }
  const before = previous(v.dir, url);
  if (before && JSON.stringify(before.sections) === JSON.stringify(sections)) {
    unchanged++;
    continue;
  }
  const dir = path.join(v.dir, TODAY);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "menu.json"), {
    date: TODAY,
    // The park lists what it serves but publishes no prices.
    unpriced: true,
    source: { name: CREDIT, official: true, url },
    sections,
  });
  written++;
  console.log(`+ ${path.relative(MENUS, dir)}/menu.json  (${items} dishes, ${sections.length} sections)`);
}
console.log(`${PARK}: ${written} written, ${unchanged} unchanged, ${empty} with nothing listed, ${passes} pass discounts recorded`);
