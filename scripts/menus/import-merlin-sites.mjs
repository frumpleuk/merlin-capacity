// Read what Merlin's UK park websites say about each place to eat: the park's
// own line about it, the features it ticks (card only, vegan options) and
// whether an Annual Pass gets a discount there.
//
//   node scripts/menus/import-merlin-sites.mjs [park_key...]
//
// Two layouts on the same CMS:
// - Thorpe Park and Chessington: one page of cards
//   (`.four-column-gallery-block__content`), each an `h3` name, a paragraph
//   about the place, then `<p>✓ ...</p>` per feature.
// - Legoland Windsor: a page per venue, its features an `ul.icons-list` under
//   "Build Your Visit...". No blurb is taken there; the intro runs to several
//   paragraphs.
// Alton Towers' pages carry none of this.
//
// Each venue gets `site: { url, serves, features, fetched }` in its poi.json
// (`serves` is the venue sync's for Flamingo Land, so this keeps its own key).
// A pass-discount tick becomes `passDiscount` with `source: "park website"`,
// never over one we know better (a board photo, a hand note). A card that
// matches no venue folder is listed, not invented. One page a second.
import fs from "node:fs";
import path from "node:path";
import { MENUS, parkDir, slug, venues, writeJson } from "./lib.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITES = {
  thorpe_park: {
    cards: "https://www.thorpepark.com/explore/theme-park/restaurants-shops/",
  },
  chessington: {
    cards:
      "https://www.chessington.com/explore/food-drinks-shops/places-to-eat/",
  },
  legoland: {
    sitemap: "https://www.legoland.co.uk/en/sitemap.xml",
    pages: /\/explore\/facilities\/dining\/[\w-]+\/$/,
  },
};

/** Site names that don't read the same as the venue's app name. A list means
 *  one card covers several outlets of the same brand. */
const ALIASES = {
  thorpe_park: {
    "Pizza & Pasta Buffet": "Inferno's Pizza & Pasta Buffet",
    "Burger King®": ["Burger King (Dobble Tea Party)", "Burger King (Hyperia)"],
    "Costa Coffee Shack": "Coffee Shack",
    "Churros & Shakes": "Churros, Waffles & Shakes",
  },
  chessington: {
    "The Vampire Burger Kitchen": "Vampire's Burger Kitchen",
    "Pizza Pasta": "Adventure Point Pizza Pasta",
    "Dragon's Delights": "Dragon Delights",
    "Ben & Jerry's": "Ben & Jerry's Scoop Shop",
  },
  legoland: {
    "LEGOLAND® Coffee Co": [
      "Beginning Coffee Co.",
      "DUPLO® Valley Coffee Co.",
      "Fire Academy Coffee Co.",
      "Pirate's Coffee Co.",
    ],
  },
};

async function get(url) {
  const resp = await fetch(url, { headers: { "user-agent": UA } });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  const text = await resp.text();
  await sleep(1000);
  return text;
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

/** Names compared loosely: "Ben & Jerry's" and "Ben and Jerrys" are one place. */
const key = (s) =>
  slug(s.replace(/&|\band\b|\bthe\b/gi, " ").replace(/['’®™]/g, ""));

/** [{ name, serves, features }] from a page of cards. */
function cards(html) {
  const out = [];
  for (const block of html
    .split(/class="four-column-gallery-block__content\b/)
    .slice(1)) {
    const body = block.slice(0, block.search(/<\/div>/));
    const name = strip(body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => strip(m[1]))
      .filter(Boolean);
    const features = paras
      .filter((p) => p.startsWith("✓"))
      .map((p) => p.replace(/^✓\s*/, "").trim());
    const serves = paras.filter((p) => !p.startsWith("✓")).join(" ") || null;
    if (name && (features.length || serves))
      out.push({ name, serves, features });
  }
  return out;
}

/** { name, features } from one venue page. */
function venuePage(html) {
  const name = strip(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const list =
    html.match(
      /<ul class="[^"]*\bicons-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/,
    )?.[1] ?? "";
  const features = [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
    .map((m) => strip(m[1].replace(/<svg[\s\S]*?<\/svg>/g, "")))
    .filter(Boolean);
  return { name, serves: null, features };
}

/** The pass tick, as a passDiscount, or null. */
function passFrom(features) {
  const tick = features.find((f) => /annual pass/i.test(f));
  if (!tick) return null;
  const gp = /gold\s*&\s*platinum/i.test(tick);
  return {
    offered: true,
    percent: null,
    applies: gp ? "Gold & Platinum Annual Pass" : null,
    source: "park website",
  };
}

const wanted = process.argv.slice(2);
for (const [park, site] of Object.entries(SITES)) {
  if (wanted.length && !wanted.includes(park)) continue;
  const found = [];
  if (site.cards) {
    for (const c of cards(await get(site.cards)))
      found.push({ ...c, url: site.cards });
  } else {
    const urls = [...(await get(site.sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1])
      .filter((u) => site.pages.test(u));
    for (const url of urls) {
      try {
        const v = venuePage(await get(url));
        if (v.name && v.features.length) found.push({ ...v, url });
      } catch (e) {
        console.warn(`! ${url}: ${e.message}`);
      }
    }
  }

  const byKey = new Map();
  for (const v of venues(parkDir(park))) {
    if (v.poi.appMissingSince || v.poi.goneSince) continue;
    for (const n of [v.poi.display, v.poi.name].filter(Boolean))
      byKey.set(key(n), v);
  }
  let written = 0;
  const unmatched = [];
  const seen = new Set();
  for (const f of found) {
    const names = [ALIASES[park][f.name] ?? f.name].flat();
    const matched = names.map((n) => byKey.get(key(n))).filter(Boolean);
    if (!matched.length) {
      unmatched.push(f.name);
      continue;
    }
    for (const v of matched) {
      if (seen.has(v.dir)) continue; // a card repeated in another carousel
      seen.add(v.dir);
      const pass = passFrom(f.features);
      const features = f.features.filter((x) => !/annual pass/i.test(x));
      const siteNew = { url: f.url, serves: f.serves, features };
      const prev = v.poi.site ?? {};
      const same =
        JSON.stringify({
          url: prev.url,
          serves: prev.serves,
          features: prev.features,
        }) === JSON.stringify(siteNew);
      const poi = {
        ...v.poi,
        site: same ? prev : { ...siteNew, fetched: TODAY },
      };
      // Only fill or refresh our own website-sourced discount.
      if (
        pass &&
        (!v.poi.passDiscount || v.poi.passDiscount.source === "park website")
      )
        poi.passDiscount = pass;
      if (JSON.stringify(poi) === JSON.stringify(v.poi)) continue;
      writeJson(path.join(v.dir, "poi.json"), poi);
      written++;
      console.log(
        `+ ${path.relative(MENUS, v.dir)}: ${[pass ? "pass discount" : null, ...features].filter(Boolean).join("; ")}`,
      );
    }
  }
  console.log(
    `${park}: ${found.length} on the site, ${written} venues updated`,
  );
  if (unmatched.length)
    console.log(`  no venue folder: ${unmatched.join(", ")}`);
}
