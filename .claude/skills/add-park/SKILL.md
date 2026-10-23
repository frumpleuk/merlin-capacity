---
name: add-park
description: Add a theme park to the site end to end - live queues, opening hours, park picker, Food & Drink, Links - and verify it in production. Use when the user asks to add, onboard or cover a new park, or to bring an existing park's tabs up to the others.
---

# Add a park

A park isn't done until it has every tab the others have: Calendar, Queues,
Uptime, Food & Drink and Links. Work through all of this unless the user scopes
it down, and don't scope it down yourself because a park seems minor (seasonal
scare parks got every tab too). If a park is added at all, it's done
consistently and well. Commit and push each stage once it's checked (trunk-based, straight to
main); a push deploys.

Background: `docs/attractions-io-api.md`, `docs/accesso-api.md`,
`docs/apk-download.md`, and one `docs/<park>-api.md` per non-Attractions.io
backend (`paultons-api.md`, `flamingoland-api.md`, `blackpool-api.md`,
`disneylandparis-api.md`, `drayton-api.md`).

## 1. Find the backend

- Look for the park in ThemeParks/parksapi (`git clone --depth 1
  https://github.com/ThemeParks/parksapi`, `src/parks/`). Its module tells you
  the backend and what's park-specific.
- Attractions.io parks are in the public bundle bucket:
  `https://s3-eu-west-1.amazonaws.com/attractions-io-production-app-data-bundles?list-type=2&prefix=app-data/&delimiter=/`
  lists every slug.
- Anything else (First Option, Firestore, a bespoke API, Disney) needs a new
  `queue.kind` modelled on `src/firstoption.ts`, `src/firebase.ts`,
  `src/bpb.ts` or `src/dlp.ts`, plus its own doc.

## 2. Get the app's key

1. Find the Android package: the park site's Play Store link
   (`play.google.com/store/apps/details?id=`). `https://play.google.com/store/apps/details?id=<pkg>`
   returning 200 confirms it.
2. Get the APK. APKPure 403s from here, so ask the user to download the XAPK in
   a browser into `~/Downloads` (give them `https://apkpure.com/-/<pkg>` links).
   If APKPure says 410 (region-locked, as Legoland Japan and Korea were), the
   user installs it on their Android phone with wireless debugging on and gives
   you IP:port. Then:
   `~/Library/Android/sdk/platform-tools/adb connect <ip:port>`,
   `adb shell pm path <pkg>`, `adb pull <base.apk path>`, `adb disconnect`.
3. Attractions.io: `apktool d -q -f -r <base>.apk -o out` and read `API_KEY`
   and `WEB_LINK_DOMAIN` from `out/smali_classes*/attractionsio/com/app/BuildConfig.smali`.
   The domain prefix is the bundle slug. Keys can be v4 or v5 UUIDs. The
   manifest's `io.attractions.API_KEY` is a vendor key shared by every park;
   don't use it. Check: `https://live-data.attractions.io/<key>.json` returns
   200.
4. React Native apps (Expo, `assets/index.android.bundle` is Hermes bytecode):
   decompile with `hbc-decompiler` (`pip install
   git+https://github.com/P1sec/hermes-dec`) and grep the output for the config
   object (`discoveryUrl`, `apiKey`, `baseUrl`). Drayton Manor's TE2 config was
   found this way (`docs/drayton-api.md`).
5. **Keys never go in the repo; it's public.** Each park's key is a Worker
   secret, `APP_KEY_<PARK KEY IN CAPS>`:
   `npx wrangler secret put APP_KEY_<PARK>`, plus the same line in `.dev.vars`.
   Leave the field empty in config.ts; `src/app-keys.ts` fills it in. Set the
   secret before pushing, or the park's polls run keyless. Never paste a key
   into docs either.

## 3. Opening hours

- Merlin sites all serve `https://www.<host><prefix>/api/openinghours/getcalendar?lang=<lang>&locationIds=<ids>`.
  - **IDs:** the ids are in the park's hours page as `window.locationIds = [...]`.
  - **Prefix:** the US parks sit under a path prefix (`legoland.com/florida`).
  - **Language:** Japan and Korea answer only with `lang=en-US`.
  - **Kinds:** call the API and check each location's name. Keep the theme park
    and any water park or golf; set the `kind` accordingly.
- Anything else gets a new `openingHours.kind` in `src/hours.ts` (see
  `knoebels`, `bpb`, `paultons`).
  - **Robots:** read the site's `robots.txt` first and honour any crawl delay
    (Knoebels: 10 seconds, so it runs once a day).
  - **Partial fetches:** a fetch that can fail part-way must return `ok:false`
    rather than a partial snapshot, because the iCal feed is built from it.

## 4. Config and park picker

- **`src/config.ts` `PARKS`:** `key`, `label`, `timeZone` (IANA; default is
  London), `openingHours` and `queue` (key field left `""`, see §2.5). A new
  `queue.kind` with a key also needs a case in `src/app-keys.ts`. Leave `products: []` unless ticket
  tracking is in scope. Set `merlinPass: true` only for parks on the UK Merlin
  Annual Pass.
- **`frontend/src/catalog.ts` `PARKS`:** the same `key`, `label` and `timeZone`,
  plus:
  - `slug`: set by hand; it's the URL and must never change.
  - `country`: ISO 3166 alpha-2.
  - `operator`: unset for an independent.
  - `resort`: only when it shares a resort with another listed park.
- **Day keys:** queue days are park-local, 04:00 to 04:00 (`parkDay` in
  config.ts). A park open past 04:00 local would break closed-all-day seeding;
  stop and raise it if one comes up.

## 5. Check before pushing

`npm run typecheck`, then `npm run check:park -- <key>`. It runs the real
catalog build, a live queue read and the hours fetch in Node against the live
APIs in seconds. For the full pipeline, `wrangler dev --test-scheduled` then
`curl "localhost:8787/poll?key=$(grep POLL_KEY .dev.vars | cut -d= -f2)"`
builds catalogs, polls and writes day files to the local D1/R2. Look for:
- **Ride names:** rides named, not empty, not "Ride NNNN" across the board. A
  bundle with locale-map text is read via `text()` in `src/rides.ts`; extend it
  if a new shape appears.
- **Grouping:** fine if missing (rides fall under Other); say so to the user.
- **Opening window:** shown in local time and matching the park's hours.
- **Hours:** days and times look right, and events are events (not last-entry
  notes; see `classifyLastEntry`).

## 6. Deploy and verify

1. **Push**, and wait for the deploy: `npx wrangler deployments list`.
2. **Build ride catalogs:** run
   `curl "https://themeparks.frumple.co.uk/poll?key=$(cat .poll | sed 's/^POLL_KEY=//')"`.
   An Attractions.io park isn't polled until its catalog exists, and this
   builds it.
3. **Check production:**
   - **Day file:** `/queues/<key>/index.json` and `/queues/<key>/<park day>.json`
     exist under the right local date, with named rides and no line id 0.
   - **Polling:** D1 `poll_log` shows the park polling:
     `npx wrangler d1 execute merlin-capacity --remote --json --command "SELECT park, MAX(observed_at) FROM poll_log WHERE product='queues' GROUP BY park"`.
   - **Pages:** Queues and Calendar render (playwright-core screenshot).
4. **Name "Ride NNNN" lines:** `node scripts/past-names.mjs <key>` looks up
   queue lines the current bundle doesn't name in the park's archived bundles
   and writes `src/past-names.json`. Commit it, push, and `/poll` again so the
   catalog picks the names up.

## 7. Food & Drink

1. **Folder and currency:** add the park to `scripts/menus/lib.mjs`:
   - `PARK_DIRS` for a Merlin park (under `contrib/menus/merlin/`),
     `ATTRACTIONS_INDIE_PARK_DIRS` for an independent Attractions.io park, or
     its own map for another backend.
   - Add its currency to `CURRENCY` (ISO 4217).
2. **Venues:** `node scripts/menus/sync-venues.mjs <key>`.
   - Check the eating categories it matched (the `FOOD` regex).
   - Watch for `!` lines and for refill machines filed as food.
   - Venues sharing a name get land- or id-suffixed folders.
   - Non-Attractions.io parks need their own sync (`sync-venues-indie.mjs`,
     `sync-venues-dlp.mjs`).
3. **Basemap:** `node scripts/menus/basemap.mjs <key>`. Overpass rate-limits,
   so retry with a pause.
4. **Build:** `node scripts/menus/build.mjs`, then `node scripts/menus/validate.mjs`.
5. **Check and commit:** look at the Food tab, then commit `contrib/menus/...`,
   the basemap, `frontend/public/menu-data` and `menus.index.json`.

## 8. Links

Add a `PARK_LINKS` entry in `frontend/src/links.ts`. The research parallelises
well: one agent per park or region, told to read `links.ts` first and return an
object literal.
- **Fields:** website; location (address, postcode, `drive` car park from the
  park's directions page or an OpenStreetMap `amenity=parking` way, cited in a
  comment, or left out); booking; orders; rideAvailability (optional, as some
  parks publish none); openingTimes; access; photos; apps; social.
- **Verify every URL live with a desktop UA, and don't trust a bare 200 from:**
  - accesso stores, which answer any path, so check the keyword is in the
    merchant's catalog;
  - Instagram, TikTok and Pinterest, so check the page title;
  - Facebook, which needs browser headers.
- **Never invent** a URL, id, address or coordinate.
- **accesso helpers:** `bookTickets()` only fits stores that carry the UK
  `SnapWizard/SnapWizardAdmission` keyword. Use the store's own keyword or the
  park's tickets page instead. `findOrder(origin, wallet, lang)` takes the
  store's language (`en-dk`, `en-de`, `en-jp`, `en-kr`) so it opens in
  English.
- **Notes:** short, factual, plain hyphens.

## 9. Not by default

- **Ticket availability:** accesso stacks differ.
  - UK and European parks are on `meg-eu`; the catalog needs that store's own
    `l=` (`en-dk`, `en-de`), not `en-gb`.
  - Asia is on `meg-as`.
  - North America is on `meg-na`, where app id 1500 has no config.
  - Gardaland uses Vivaticket; Knoebels uses eGalaxy behind Cloudflare.

  Merchant ids, store hosts, keywords and what each stack returned are in
  `docs/accesso-api.md` §9. Raise it with the user rather than starting.
- **Menus:** they come from photos (`/menus-add-photos`, `/menus-transcribe`).

## 10. Afterwards

- **Memory:** update `attractions-io-park-rollout` (or the backend's memory)
  with the park, key source and any gotcha.
- **Docs:** if you learned something about getting keys, update
  `docs/apk-download.md`.
- **Report:** tell the user what's live, what each tab shows, and the gaps (no
  grouping, unnamed rides, missing links), with the commits.
