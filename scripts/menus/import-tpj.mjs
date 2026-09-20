// Import menus from Theme Park James (themeparkjames.co.uk), with credit.
//
// He photographs and types up park menus, including ones we've never seen and
// past menus going back years, which is exactly the history our own photos
// can't reach. Prices are facts, but the work of collecting them is his: every
// menu we take carries a `source` block naming him and linking the page it came
// from, and the site shows that credit.
//
//   node scripts/menus/import-tpj.mjs plan [park_key...]
//     Fetches his sitemap, reads every menu page for those parks, and writes
//     contrib/menus/.tpj-plan.json proposing which of our venues each belongs
//     to (by name). Check the guesses, fix `venue`, null it to skip.
//   node scripts/menus/import-tpj.mjs apply
//     Writes each planned menu to <venue>/<date>/menu.json.
//
// Fetching is one page a second with a named user agent, and every page is
// cached, so a re-run costs him nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_PARK_DIRS, MENUS, parkDir, readJson, slug, venues, writeJson } from "./lib.mjs";

const SITE = "https://www.themeparkjames.co.uk";
const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive, contact via site)";
const CACHE = path.join(os.tmpdir(), "tpj-cache");
const PLAN = path.join(MENUS, ".tpj-plan.json");
const CREDIT = "Theme Park James";

/** His park path segment for each of our park keys. He has no food-and-drink
 *  pages for Blackpool, so that park isn't here. */
const TPJ_PARKS = {
  alton_towers: "alton-towers",
  thorpe_park: "thorpe-park",
  chessington: "chessington-world-of-adventures",
  legoland: "legoland-windsor",
  paultons: "paultons-park",
  flamingoland: "flamingo-land",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, slug(url.replace(SITE, "")) + ".html");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const resp = await fetch(url, { headers: { "user-agent": UA } });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  const html = await resp.text();
  fs.writeFileSync(file, html);
  await sleep(1000); // his server, our impatience
  return html;
}

const strip = (html) =>
  html
    // A line break is a break in the text, not a join: "…and fries<br>Add
    // onions…" is two sentences, and stripping the tag alone would weld them.
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TAGS = { vegetarian: "v", vegan: "vg", "gluten free": "gf", "dairy free": "df" };

/** His menus are tables: th.price-list starts a section, tr.price-list is an
 *  item, td.price-list-price holds the price, a <p> inside the name cell is the
 *  description, and dietary marks are icons with alt text. A section's name
 *  and the italic note under it are two header rows, not two sections. */
function parseMenu(html) {
  const sections = [];
  let current = null;
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  for (const row of rows) {
    const head = row.match(/<th[^>]*class="[^"]*price-list[^"]*"[^>]*>([\s\S]*?)<\/th>/);
    if (head) {
      const text = strip(head[1]);
      if (!text) continue;
      // The note row ("Served in a toasted bun…") is italic and follows the
      // name row, so it belongs to the section already open.
      if (current && /<(em|i)[\s>]/i.test(head[1])) {
        current.note = current.note ? `${current.note} ${text}` : text;
        continue;
      }
      current = { name: text, items: [] };
      sections.push(current);
      continue;
    }
    const cells = [...row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)];
    if (cells.length < 2) continue;
    const priceCell = cells.find((c) => /price-list-price/.test(c[1]));
    const nameCell = cells.find((c) => c !== priceCell);
    if (!priceCell || !nameCell) continue;
    const money = strip(priceCell[2]).match(/£\s*([\d.]+)/);
    if (!money) continue;
    const desc = nameCell[2].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const tags = [...nameCell[2].matchAll(/alt="\(([^)]+)\)"/g)]
      .map((m) => TAGS[m[1].toLowerCase()])
      .filter(Boolean);
    const name = strip(nameCell[2].replace(/<p[\s\S]*?<\/p>/g, ""));
    if (!name) continue;
    if (!current) {
      current = { name: "Menu", items: [] };
      sections.push(current);
    }
    current.items.push({
      name,
      ...(desc ? { description: strip(desc[1]) } : {}),
      price: Math.round(parseFloat(money[1]) * 100),
      ...(tags.length ? { tags: [...new Set(tags)] } : {}),
    });
  }
  return sections.filter((s) => s.items.length);
}

const MONTHS = "january february march april may june july august september october november december".split(" ");

/** The date he gives for a menu: "from November 2023", or a year in its title. */
function dateOf(html, title) {
  const text = strip(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ""));
  const full = text.match(/from\s+([A-Z][a-z]+)\s+(\d{4})/);
  if (full && MONTHS.includes(full[1].toLowerCase())) {
    const month = String(MONTHS.indexOf(full[1].toLowerCase()) + 1).padStart(2, "0");
    return { date: `${full[2]}-${month}-01`, stated: `${full[1]} ${full[2]}`, approx: true };
  }
  const year = (title.match(/\b(20\d{2})\b/) ?? text.match(/\b(20\d{2})\b/))?.[1];
  if (year) return { date: `${year}-01-01`, stated: year, approx: true };
  return null;
}

/** Which of our venue folders this menu is probably for. */
function guessVenue(parkDir, name) {
  const words = (s) => new Set(slug(s).split("-").filter((w) => w.length > 2));
  const mine = words(name);
  let best = null;
  for (const v of venues(parkDir)) {
    if (v.dir.includes(`${path.sep}water${path.sep}`)) continue;
    const theirs = words(v.poi.name ?? path.basename(v.dir));
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const score = shared / Math.max(1, Math.min(mine.size, theirs.size));
    if (score > 0 && (!best || score > best.score)) {
      best = { venue: path.relative(parkDir, v.dir), name: v.poi.name, score: +score.toFixed(2) };
    }
  }
  return best && best.score >= 0.5 ? best : null;
}

async function plan(wanted) {
  const locs = [...(await page(`${SITE}/sitemap.xml`)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const out = [];
  for (const key of Object.keys(ALL_PARK_DIRS)) {
    const theirPark = TPJ_PARKS[key];
    if (!theirPark || (wanted.length && !wanted.includes(key))) continue;
    const dir = parkDir(key);
    const urls = locs.filter((u) =>
      new RegExp(`/${theirPark}/food-and-drink/[a-z0-9-]+/(menu|past-menus)/?$`).test(u),
    );
    console.log(`${key}: ${urls.length} pages`);
    for (const url of urls) {
      const html = await page(url);
      const title = strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [, ""])[1]);
      const venueName = strip((html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) ?? [, ""])[1]).replace(/,\s*[^,]+$/, "");
      // A past-menus page holds several menus, each under its own h2.
      const blocks = html.split(/<h2[^>]*>/).slice(1);
      for (const block of blocks) {
        const label = strip(block.slice(0, block.indexOf("</h2>")));
        const sections = parseMenu(block);
        if (!sections.length) continue;
        const when = dateOf(block, label) ?? dateOf(html, title);
        if (!when) {
          console.warn(`! ${url}: "${label}" has no date, skipped`);
          continue;
        }
        const guess = guessVenue(dir, venueName);
        out.push({
          park: key,
          theirName: venueName,
          label,
          url,
          // His write-up of the place, which is the page worth reading: the
          // menu page is one tab of it.
          venueUrl: url.replace(/(menu|past-menus)\/?$/, ""),
          ...when,
          venue: guess?.venue ?? null,
          matched: guess?.name ?? null,
          score: guess?.score ?? 0,
          items: sections.reduce((n, s) => n + s.items.length, 0),
          sections,
        });
      }
    }
  }
  writeJson(PLAN, out);
  for (const e of out) {
    console.log(
      `${e.park}  ${e.date}  ${String(e.items).padStart(3)} items  ${e.theirName}` +
        `  ->  ${e.venue ?? "NO MATCH"}${e.venue && e.score < 0.9 ? ` (${e.score})` : ""}`,
    );
  }
  console.log(`\n${out.length} menus -> ${path.relative(process.cwd(), PLAN)}`);
}

function apply() {
  const entries = readJson(PLAN);
  let written = 0;
  for (const e of entries) {
    if (!e.venue) continue;
    // "new:<slug>" is an outlet that has closed: the park's app doesn't list it
    // any more, so nothing else would ever create the folder. Stamp it as gone
    // on the day we learned of it, so the site files it under history.
    let slugPath = e.venue;
    if (e.venue.startsWith("new:")) {
      slugPath = e.venue.slice(4);
      const venueDir = path.join(parkDir(e.park), slugPath);
      const poiFile = path.join(venueDir, "poi.json");
      if (!fs.existsSync(poiFile)) {
        fs.mkdirSync(venueDir, { recursive: true });
        writeJson(poiFile, {
          id: null,
          name: e.newVenue?.name ?? e.theirName,
          category: null,
          area: e.newVenue?.area ?? null,
          lat: null,
          lon: null,
          note: e.newVenue?.note ?? `Known from ${CREDIT}; not in the park's app.`,
          appMissingSince: new Date().toISOString().slice(0, 10),
          source: CREDIT,
        });
        console.log(`+ ${path.relative(MENUS, venueDir)}/poi.json  (gone; known from ${CREDIT})`);
      }
    }
    const dir = path.join(parkDir(e.park), slugPath, e.date);
    const file = path.join(dir, "menu.json");
    if (fs.existsSync(file) && !readJson(file).source) {
      console.warn(`! ${path.relative(MENUS, file)} is ours (from photos), left alone`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    writeJson(file, {
      date: e.date,
      approxDate: e.approx || undefined,
      source: {
        name: CREDIT,
        url: e.url,
        venueUrl: e.venueUrl ?? e.url.replace(/(menu|past-menus)\/?$/, ""),
        stated: e.stated,
        menu: e.label,
      },
      sections: e.sections,
    });
    written++;
    console.log(`+ ${path.relative(MENUS, file)}  (${e.items} items, ${e.label})`);
  }
  console.log(`${written} menus written`);
}

const cmd = process.argv[2];
if (cmd === "plan") await plan(process.argv.slice(3));
else if (cmd === "apply") apply();
else {
  console.error("usage: import-tpj.mjs plan [park_key...] | apply");
  process.exit(1);
}
