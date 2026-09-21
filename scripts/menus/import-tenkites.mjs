// Import the menus a park publishes on Tenkites, the digital menu system its
// poi.json `menuUrl` points at. Paulton's publishes most of its outlets this
// way; Alton's hotel restaurants go through Aramark's Tenkites account.
//
//   node scripts/menus/import-tenkites.mjs [park_key...]   (default: all of them)
//
// What it gets: every dish on every board, its description, its calories and
// the park's vegetarian/vegan marks. What it does NOT get: prices. Tenkites
// renders a price element for each dish and Paulton's leaves every one of them
// empty, so these menus are written with `unpriced: true` and each item's price
// null. The prices we do have come from Theme Park James (import-tpj.mjs), who
// photographed the boards in the park.
//
// Fetching is one page a second with a named user agent, and every page is
// cached under the system temp dir, so a re-run costs the park nothing. A menu
// whose dishes haven't changed since the last import isn't written again: it
// would only add a second dated copy of the same board.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_PARK_DIRS, DATE_DIR, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const HOST = "menus.tenkites.com";
const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "tenkites-cache");
const TODAY = new Date().toISOString().slice(0, 10);

/** The park's own name for each park key, as the credit line shows it. */
const PARK_NAMES = {
  paultons: "Paultons Park",
  alton_towers: "Alton Towers Resort",
  thorpe_park: "Thorpe Park",
  chessington: "Chessington World of Adventures",
  legoland: "Legoland Windsor",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url, { browser = false } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, slug(url.replace(/^https?:\/\//, "")) + ".html");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  // The parks' own marketing sites refuse an unknown agent, so the hop through
  // one of their pages asks as a browser would. Tenkites itself is happy with
  // our named agent.
  const resp = await fetch(url, {
    headers: {
      "user-agent": browser
        ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
        : UA,
    },
  });
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
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The park's dietary marks, as printed on the card. Anything else (halal, the
 *  allergen filters) is a claim about ingredients we won't restate. */
const TAGS = { v: "v", ve: "vg", vg: "vg", gf: "gf", df: "df" };

/**
 * A Tenkites menu is a flat run of course headers and dish cards in document
 * order, so read it in that order: each `k10-course__name-text` opens a
 * section, each `k10-recipe__name` adds a dish to whichever section is open.
 * Nested courses (level_2, level_3) are headers too, which is why sub-sections
 * read as sections of their own rather than being lost.
 */
function parseMenu(html) {
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
  // Class attributes wrap across lines in this markup, so every selector here
  // matches the class inside the list rather than the attribute whole. The
  // [\s"] after a name keeps k10-recipe__name off k10-recipe__name-wrapper.
  const found = (re, kind) => [...body.matchAll(re)].map((m) => ({ kind, at: m.index, end: m.index + m[0].length, text: strip(m[1]) }));
  const tokens = [
    ...found(/class="[^"]*k10-course__name-text[\s"][^"]*"[^>]*>([\s\S]*?)<\/div>/g, "course"),
    ...found(/class="[^"]*k10-recipe__name[\s"][^"]*"[^>]*>([\s\S]*?)<\/span>/g, "dish"),
  ].sort((a, b) => a.at - b.at);

  const sections = [];
  let current = null;
  for (const [i, t] of tokens.entries()) {
    if (!t.text) continue;
    if (t.kind === "course") {
      current = { name: t.text, items: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { name: "Menu", items: [] };
      sections.push(current);
    }
    // Everything about a dish sits between its name and the next dish.
    const rest = body.slice(t.end, tokens[i + 1]?.at ?? t.end + 4000);
    const desc = strip((rest.match(/class="[^"]*k10-recipe__desc[\s"][^"]*"[^>]*>([\s\S]*?)<\/div>/) ?? [, ""])[1]);
    const kcal = rest.match(/k10-primary-nutrient__item["']>\s*([\d,]+)\s*cal/);
    const tags = [
      ...new Set(
        [...rest.matchAll(/class="[^"]*k10-recipe__label[\s"][^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
          .map((m) => TAGS[strip(m[1]).toLowerCase()])
          .filter(Boolean),
      ),
    ];
    current.items.push({
      name: t.text,
      ...(desc ? { description: desc } : {}),
      price: null,
      ...(kcal ? { kcal: Number(kcal[1].replace(/,/g, "")) } : {}),
      ...(tags.length ? { tags } : {}),
    });
  }
  return sections.filter((s) => s.items.length);
}

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
    if (!fs.existsSync(file)) continue;
    const m = readJson(file);
    if (m.source?.url === url) return { date: d, menu: m };
  }
  return null;
}

/** The Tenkites board for a venue: the link itself, or the one the park's own
 *  page points at. Returns "" when there isn't one. */
async function resolve(link) {
  if (!link) return "";
  if (link.includes(HOST)) return link;
  if (!/^https?:\/\//.test(link)) return "";
  let html;
  try {
    html = await page(link, { browser: true });
  } catch {
    return "";
  }
  return html.match(new RegExp(`https://${HOST}/[\\w/-]+`))?.[0] ?? "";
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const key of Object.keys(ALL_PARK_DIRS)) {
  if (!PARK_NAMES[key] || (wanted.length && !wanted.includes(key))) continue;
  let written = 0;
  let unchanged = 0;
  let empty = 0;
  for (const v of venues(parkDir(key))) {
    // A venue's menuUrl is sometimes the park's own page about the place,
    // which then links to its Tenkites board (Alton's hotel restaurants do
    // this). Follow that one hop rather than skipping the venue.
    const url = await resolve(v.poi.menuUrl ?? "");
    if (!url) continue;
    const sections = parseMenu(await page(url));
    const items = sections.reduce((n, s) => n + s.items.length, 0);
    if (!items) {
      // A live URL with nothing on it: the outlet is between menus (the park
      // leaves the page up), so there's nothing to record.
      empty++;
      console.log(`- ${path.relative(MENUS, v.dir)}: no dishes on ${url}`);
      continue;
    }
    const before = previous(v.dir, url);
    if (before && JSON.stringify(before.menu.sections) === JSON.stringify(sections)) {
      unchanged++;
      continue;
    }
    const dir = path.join(v.dir, TODAY);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "menu.json"), {
      date: TODAY,
      // The park lists the dishes and their calories but no prices.
      unpriced: true,
      source: { name: PARK_NAMES[key], official: true, url },
      sections,
    });
    written++;
    console.log(`+ ${path.relative(MENUS, dir)}/menu.json  (${items} dishes, ${sections.length} sections)`);
  }
  console.log(`${key}: ${written} written, ${unchanged} unchanged, ${empty} with nothing published`);
}
