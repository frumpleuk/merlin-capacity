// Capture the web pages our official menus were read from, and ask the public
// archives to keep a copy of every source.
//
//   node scripts/menus/archive-pages.mjs [--no-public]
//
// The importers call `archivePages()` after writing menus; run it by hand to
// catch up. It is idempotent: it only does what's missing.
//
// 1. Every official menu whose source is a web page (Tenkites boards,
//    Blackpool's venue pages, Flamingo Land's Coach House page) and has no
//    `source.snapshot` gets one, taken in headless Chromium:
//      png    the full page as rendered, what a visitor saw
//      html   the DOM after scripts ran
//      mhtml  the page with its CSS and images, openable offline
//      har    every request and response with contents (JS, CSS, the data
//             calls the page made)
//    Each file goes to the private archive (archive-lib.mjs) like a PDF, and
//    the menu records `source.snapshot = { captured, png, html, mhtml, har }`
//    (sha256s). `captured` is the day it was taken, which for a menu read
//    before this existed is later than the menu's own date.
// 2. Public copies: the Wayback Machine's Save Page Now for each web source
//    (`source.wayback`) and each archived PDF (its ledger entry's `wayback`).
//    archive.today is tried too, but it usually answers scripts with a
//    CAPTCHA; a copy is recorded only when one is actually made.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { archive, ledgerEntries, saveLedger, setLedgerField } from "./archive-lib.mjs";
import { ALL_PARK_DIRS, DATE_DIR, MENUS, parkDir, readJson, venues, writeJson } from "./lib.mjs";

const UA = "merlin-capacity/0.1 (+https://themeparks.frumple.co.uk; park menu archive)";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const OUT = path.join(os.tmpdir(), "park-menu-pages");
// A menu file (a PDF, or an image of the board) is archived by the importer;
// only web pages are captured here.
const isFile = (url) => /\.(pdf|jpe?g|png)(?:[?#]|$)/i.test(url ?? "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const hashFile = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** Render one page and keep it four ways. Returns { captured, png, html, mhtml,
 *  har } as sha256s, every file already in the private archive. */
async function capture(browser, url) {
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, crypto.createHash("sha1").update(url).digest("hex"));
  const har = `${base}.har`;
  const context = await browser.newContext({
    userAgent: BROWSER_UA,
    viewport: { width: 1280, height: 900 },
    recordHar: { path: har, content: "embed" },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  } catch {
    // Some pages never go quiet (Knoebels' keep polling): take them once
    // loaded, with a moment for late content.
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(5000);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  fs.writeFileSync(`${base}.html`, await page.content());
  const cdp = await context.newCDPSession(page);
  const { data } = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
  fs.writeFileSync(`${base}.mhtml`, data);
  await context.close(); // writes the HAR
  const captured = today();
  const out = { captured };
  for (const [kind, type] of [
    ["png", "image/png"],
    ["html", "text/html"],
    ["mhtml", "multipart/related"],
    ["har", "application/json"],
  ]) {
    const file = `${base}.${kind}`;
    const sha256 = hashFile(file);
    archive({ file, sha256, url, type, fetched: captured });
    out[kind] = sha256;
  }
  return out;
}

/** Ask the Wayback Machine to save `url` now. Returns the snapshot URL, or
 *  null when it declined (rate limit, robots, an error). */
async function wayback(url) {
  try {
    const resp = await fetch(`https://web.archive.org/save/${url}`, {
      headers: { "user-agent": UA },
      redirect: "manual",
    });
    const loc = resp.headers.get("content-location") ?? resp.headers.get("location");
    await sleep(6000); // anonymous Save Page Now allows a few a minute
    if (loc && /\/web\/\d{14}/.test(loc)) return new URL(loc, "https://web.archive.org").href;
    if (resp.status === 200) {
      const m = /\/web\/(\d{14})\//.exec(await resp.text());
      if (m) return `https://web.archive.org/web/${m[1]}/${url}`;
    }
  } catch {}
  return null;
}

/** Ask archive.today to save `url`. Returns the copy's URL only when it made
 *  one; a CAPTCHA or refusal returns null. */
async function archiveToday(url) {
  try {
    const resp = await fetch("https://archive.ph/submit/", {
      method: "POST",
      headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url }),
      redirect: "manual",
    });
    const loc = resp.headers.get("refresh")?.split("url=")[1] ?? resp.headers.get("location");
    await sleep(6000);
    if (loc && /archive\.(ph|is|today|li|vn|md)\/[A-Za-z0-9]{4,}$/.test(loc)) return loc;
  } catch {}
  return null;
}

/** Every official menu read from a web page, newest per URL first. */
function webMenus() {
  const out = [];
  for (const key of Object.keys(ALL_PARK_DIRS)) {
    if (!fs.existsSync(parkDir(key))) continue;
    for (const { dir } of venues(parkDir(key))) {
      for (const d of fs.readdirSync(dir).filter((d) => DATE_DIR.test(d))) {
        const file = path.join(dir, d, "menu.json");
        if (!fs.existsSync(file)) continue;
        const menu = readJson(file);
        if (menu.source?.official && menu.source.url && !isFile(menu.source.url)) out.push({ file, menu });
      }
    }
  }
  return out;
}

export async function archivePages({ publicCopies = true } = {}) {
  const todo = webMenus().filter(({ menu }) => !menu.source.snapshot || (publicCopies && !menu.source.wayback));
  let captured = 0;
  let saved = 0;
  if (todo.length) {
    const browser = await chromium.launch();
    try {
      for (const { file, menu } of todo) {
        const where = path.relative(MENUS, file);
        if (!menu.source.snapshot) {
          try {
            // A board holding several outlets' menus opens on the first, so
            // capture the venue's own (source.page, set by import-tenkites.mjs).
            menu.source.snapshot = await capture(browser, menu.source.page ?? menu.source.url);
            captured++;
          } catch (e) {
            console.warn(`! ${where}: capture failed, ${e.message}`);
          }
        }
        if (publicCopies && !menu.source.wayback) {
          const w = await wayback(menu.source.page ?? menu.source.url);
          if (w) {
            menu.source.wayback = w;
            saved++;
          } else console.warn(`! ${where}: Wayback Machine declined`);
          const t = await archiveToday(menu.source.page ?? menu.source.url);
          if (t) menu.source.archiveToday = t;
        }
        writeJson(file, menu);
        saveLedger();
      }
    } finally {
      await browser.close();
    }
  }
  // Menu files: ours already; ask for public copies of their URLs.
  let pdfs = 0;
  if (publicCopies) {
    for (const [sha256, e] of ledgerEntries()) {
      // The menu files the importers fetched, not our own page captures.
      if (!isFile(e.url) || e.wayback) continue;
      const w = await wayback(e.url);
      if (w) {
        setLedgerField(sha256, "wayback", w);
        pdfs++;
        saveLedger();
      } else console.warn(`! ${e.url}: Wayback Machine declined`);
    }
  }
  console.log(`${captured} pages captured, ${saved} pages and ${pdfs} PDFs saved to the Wayback Machine`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await archivePages({ publicCopies: !process.argv.includes("--no-public") });
}
