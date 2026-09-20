# Paulton's Park API — Reference

How **Paulton's Park** (home of Peppa Pig World) exposes the three data streams
this repo tracks: live **ride queue times** (from the official app's backend,
§1–5) plus the **opening-hours calendar** and **day-ticket availability** (from
plain JSON on the public website, §6). Paulton's is an **independent** park — NOT
Merlin — so none of this is the accesso ticketing (`docs/accesso-api.md`),
Attractions.io live feed (`docs/attractions-io-api.md`), or marketing-site
`getcalendar` the Merlin parks use. Like Blackpool (`docs/blackpool-api.md`) it's
a **full calendar + queue park**, but its calendar *and* capacity come from its
own site rather than accesso.

The queue facts (§1–5) were obtained by decompiling the Android app
(`thrillseeker.app.paultons`) and exercising the live endpoint; the calendar and
capacity blobs (§6) are the same JSON the paultonspark.co.uk site fetches itself.

---

## 1. App shape

Unlike the four Merlin apps (native, with a `BuildConfig.API_KEY`), the Paulton's
app is a **Capacitor hybrid web app** — the UI is a bundled web app under
`assets/public/` and all config lives in its JS, not in Android resources.

Attractions.io *does* work with Paulton's, but only for **internal wait-time
management and on-site digital signage** (per their public partnership
announcement). The **guest app does not use the Attractions.io live feed** — there
is no `live-data.attractions.io` reference anywhere in the bundle. Queue times
come from a custom backend by **First Option Software**.

---

## 2. Host & auth

| | |
|---|---|
| **Base URL** | `https://paultonsapp.firstoptionsoftware.com` |
| **Auth** | static app-embedded token in the **`x-token`** header |
| **Token** | `Nn2ibRudVbMVlAsp` (the app's `apiFixedToken`; also accepted as `?token=`) |

The app's HTTP interceptor attaches every in-`/api` request with
`.set("x-token", apiFixedToken).set("is-mobile", …)`. The token is a static
client identifier embedded in the app (same class as the accesso app-id/merchant
headers or the Attractions.io api-key), not a user credential.

`Authorization: Bearer <token>` does **not** work (returns `Unauthorized`); it
must be the `x-token` header (or the `?token=` query param).

---

## 3. Endpoint

```
GET /api/queue-times          (with x-token header)
```

- A wrong path returns `{"errors":[{"message":"Route … doesn't exist.","extensions":{"code":"ROUTE_NOT_FOUND"}}]}`.
- Missing/incorrect auth returns the plain text `Unauthorized`.

### Response

A single **flat JSON array, one row per ride** — no per-queue-line split, no
static/live merge, and the ride **name is inline**:

```json
[
  { "rideId": 48, "statusOpen": false, "queueTime": 20, "seats": 21,
    "updatedAt": "2026-07-21T16:52:16.846Z", "ride": { "name": "Splash Lagoon" } },
  { "rideId": 49, "statusOpen": false, "queueTime": 15, "seats": null,
    "updatedAt": "2025-02-06T08:10:14.908Z", "ride": { "name": "Peppa Pig World Show Stage1" } }
]
```

| Field | Type | Meaning |
|---|---|---|
| `rideId` | int | Ride id (join key; also the primary display id). |
| `statusOpen` | bool | Open to guests **right now**. No separate "operational" flag. |
| `queueTime` | int | Posted wait in whole **MINUTES** (values are multiples of 5, e.g. 0/5/10/20). **Always present** — it's the ride's LAST-KNOWN wait and is NOT nulled when the ride closes, so it does *not* signal open/closed. |
| `seats` | int / null | Ride capacity/seats (unused here). |
| `updatedAt` | string | ISO-8601 (UTC) of the last state change — **the real open/closed & "ran today" signal**. A ride open now updates continuously; a ride closed at 16:50 keeps `updatedAt` at its closing time; a defunct/removed attraction keeps a stale timestamp (2022/2024/2025 dates seen). |
| `ride.name` | string / null | Display name. |

> **This is a last-known-STATE feed, not a live instantaneous overlay.** Each row
> is the ride's *latest* state plus *when* it was set — there's no intraday
> history in a single read; you build the curve by polling. Observed once after
> close: 54 rows, all `statusOpen:false`, all with a non-null `queueTime`
> (residual last wait), 45 with a same-day `updatedAt` (ran that day) and 9 stale
> (defunct). Reading `queueTime` as the open/closed signal is wrong — use
> `updatedAt`/`statusOpen`.

---

## 4. Notes & caveats

- **Names are inline** → there is no content bundle to download/unzip and no
  daily catalog cron. The catalog is synthesised from the feed each poll.
- **Closed-hours values.** When `statusOpen` is false, `queueTime` may still
  carry a stale number; treat the wait as meaningful only while open.
- **Defunct rides linger.** Rows with a months-old `updatedAt` (e.g. removed
  shows) still appear, `statusOpen:false`. They currently render as closed-all-day;
  a future refinement could filter by `updatedAt` freshness or a POI category.
- **No park hours in this feed** (the Attractions.io feed carried a `Resort`
  opening window). We instead frame the sparkline x-axis with the day's real
  opening times, read from the public `times.json` calendar (§6) — see
  `fetchPaultonsWindow` in `src/queues.ts`. Before that was wired the axis fell
  back to the captured-data span.
- **Undocumented / private API.** None of this is published; the host, path, and
  token can change without notice. The token is an app-embedded client
  identifier, not an entitlement.

---

## 5. Integration (this repo)

Modelled as a `QueueSource` of `kind: "fos"` (`src/config.ts`). `src/firstoption.ts`
fetches `/api/queue-times`, normalises each row into the shared `QueueObs` model as
a single synthetic queue line keyed by `rideId` (`statusOpen` → is_open &
is_operational; the residual `queueTime` is **kept**, not nulled), and synthesises
a `RideCatalog` from the inline names (persisted to R2 only when the name set
changes). Two rules make the closed/never-ran distinction correct given this is a
last-known-state feed:

1. **Skip defunct rides** — `updatedAt` older than `STALE_DAYS` (14) is a removed
   or long-closed attraction (self-correcting: a seasonal ride reappears once it
   next changes state).
2. **Only emit a snapshot row for a ride that changed state *today*** (`updatedAt`
   is today = "ran today"). Current rides that didn't change today get no row and
   are seeded as closed-all-day from the catalog, like an Attractions.io ride with
   no observations.

The frontend's "ran today vs closed-all-day" test also counts a closed row that
carries a posted wait (Paulton's keeps the last wait after close), so a
ran-today-then-closed ride reads "Closed", not "Closed all day". Everything else —
D1 `queue_observation`, day-file generation, the Queues tab — is reused unchanged.
Paulton's rides the existing every-minute queue cron and is excluded from the
Attractions.io catalog cron.

**Grouping.** The queue API carries only ids + names, so ride grouping is EMBEDDED
in `src/paultons-groups.ts`, extracted from the app's bundled
`points_of_interest.json` (joined to the queue `rideId` via the POI `orms_id`).
Two dimensions: **thrill** (`filter_tags` → Little Ones / Family Rides / Thrill
Rides, 37/42 rides) and **themed area** (`category_tags` → Peppa Pig World /
Tornado Springs / Lost Kingdom / Critter Creek, 27/42). Both ride on the generic
`RideCatalog.groupDims` + `RideMeta.groups` model (backward-compatible — the Merlin
parks keep their single `group`), and the Queues tab shows a Group toggle when a
file has >1 dimension. Refresh the mapping by re-reading the POI DB from a newer
APK; a new/untagged ride simply falls to "Other".

---

## 6. Opening-hours calendar & day-ticket capacity (public site JSON)

Separate from the app's queue backend, the **paultonspark.co.uk** website fetches
three static JSON files. All are **unauthenticated** and served by plain nginx
(`server: nginx`) — **any User-Agent works, no Cloudflare / header gotchas** (the
opposite of Blackpool). These give Paulton's a real opening-hours calendar AND an
availability heatmap, so it's no longer queue-only.

| File | Powers |
|---|---|
| `GET /info/opening-times/times.json` | Opening hours (calendar + queue sparkline window) |
| `GET /info/opening-times/special-events.json` | Event badges on the calendar |
| `GET /tickets/availability.json` | Day-ticket capacity heatmap (the "main" product) |

### 6.1 `times.json` — opening hours

A flat array; each entry is one set of hours shared by a list of dates (24-hour,
**local** time). One entry per distinct open/close pair, not per date:

```json
[
  { "open": "10:00", "closed": "17:30",
    "dates": ["2026-07-15", "2026-07-16", "…"] },
  { "open": "10:30", "closed": "16:00", "dates": ["2026-11-07", "2026-11-08"] }
]
```

- Range observed: ~160 dates, today → ~6 months out (into early January).
- A date **absent** from every entry = the park is closed that day (no row).
- These local times drive two things: the calendar's `"10am - 5:30pm"` row, and
  the queue sparkline's x-axis window (converted to minutes-since-UTC-midnight
  via the London offset — BST 10:00 → 540, 17:30 → 990).

### 6.2 `special-events.json` — event date ranges

A flat array of **date ranges** (not per-day), timestamps as **unix seconds
strings**:

```json
[
  { "start": "1794052800", "end": "1795996799", "tag": "leaf",
    "name": "November Reduced Rate Day - Selected Rides Open." }
]
```

| Field | Meaning |
|---|---|
| `start` / `end` | Inclusive unix-second range the event spans. |
| `tag` | A UI category/icon key (e.g. `"leaf"`); unused here. |
| `name` | Human-readable event name → the calendar day-badge. |

We badge every **open** day (i.e. present in `times.json`) that falls inside a
range; a range-only day with no hours gets no row, so events only ever decorate
real operating days.

### 6.3 `availability.json` — day-ticket capacity

An object with a `days` array, one entry per on-sale date:

```json
{ "days": [
  { "sold_out": false, "suspended": false,
    "date": "2026-07-22T00:00:00+01:00",
    "availability": { "total": 3750, "available": 943 },
    "performances": [
      { "id": "PPK.EVN2.PRF3253", "sold_out": false, "sellable": true,
        "availability": { "total": 3750, "available": 943 },
        "start_date": "2026-07-22T07:00:00+00:00",
        "end_date":   "2026-07-22T18:59:00+00:00" } ] }
] }
```

| Field | Meaning |
|---|---|
| `date` | Local-midnight ISO (`…+01:00`); its first 10 chars are the calendar date. |
| `availability.total` | The day's ticket capacity. |
| `availability.available` | Tickets remaining. |
| `sold_out` / `suspended` | Day flags — treat as **0 remaining** whatever the number says. |
| `performances[]` | Per-slot breakdown (the admission window, wider than opening hours); we use only the day-level `availability`, not these. |

- Range observed: ~122 days, today → early January. No sold-out/suspended days in
  the sample, but both are handled.
- **Not accesso.** There's no `capacity/used` split — we derive
  `used = total − available` to fit the shared `DayObs` model.

### 6.4 Integration (this repo)

- **Hours + events** → `OpeningHoursConfig` of `kind: "paultons"` (`src/config.ts`);
  `fetchPaultonsHours` (`src/hours.ts`) fetches both blobs (a failed
  `special-events` fetch just drops the badges, it doesn't fail the poll), formats
  `"10am - 5:30pm"` rows, and bubbles the event onto each open day in range. Output
  is the shared `HoursSnapshot`, so month-file writing / the calendar UI are reused.
- **Capacity** → a `ProductConfig` with `availabilityUrl` set (no accesso
  `P`/`discover`). `runPoll` (`src/poll.ts`) branches on `availabilityUrl` →
  `fetchPaultonsAvailability` (`src/paultons.ts`) → the same `Snapshot`/`DayObs`
  the accesso parks produce, so the whole diff → D1 delta log → month files →
  heatmap pipeline is reused byte-for-byte. `onSale` is left **undefined**
  (Paulton's has no prebook "yield anchor" concept, so no lock badge).
- **Queue window** → `fetchPaultonsWindow` (`src/queues.ts`) reads today's row
  from `times.json` and stamps `open`/`close` (UTC minutes) onto the queue day
  file; `appendQueueDayFile` fills it in if the 30-min self-heal created a
  window-less file first. See §4.
- Frontend: the Paulton's `ParkDef` (`frontend/src/catalog.ts`) drops `queueOnly`
  and gains a `main` product → **Calendar + Tickets + Queues** tabs.

**Undocumented / private.** As with the queue API, these paths aren't published
and can change without notice.

---

## 7. Eateries & menus (app bundle + Tenkites)

The Food tab needs two things the queue API doesn't carry: where each outlet is,
and what it sells. Both exist, in two different places.

### 7.1 Where the outlets are — `points_of_interest.json`

The app's POI database (the same bundled file the ride grouping comes from,
§5) is the park's whole map, food included. It is **not served over the API**:
`/api/*` has only the routes in §3 and `/assets/*` answers `FORBIDDEN` to the
app token, so a refresh means unpacking a newer APK (`docs/apk-download.md`).

```
assets/public/assets/databases/points_of_interest.json   (145 POIs, app v10.3.3)
```

Food outlets are `type: "restaurant"` — **19 of them, every one with
coordinates**:

| Field | Meaning |
|---|---|
| `id` | POI id. Our `poi.json` id; unrelated to the queue feed's `rideId` (food POIs have `orms_id: null`). |
| `title` | The outlet's name. |
| `type` | `"restaurant"` for food and drink. |
| `status` | `published`, or **`archived`** for an outlet that has closed (`date_updated` is when). |
| `location` | GeoJSON `Point`, `coordinates: [lon, lat]`. `entrance_location` too on some. |
| `category_tags` | `Food and Drink`, plus the themed area for a couple of them. |
| `menu` | The outlet's **Tenkites menu URL** (18 of 19 have one). |
| `short_description` / `full_description` | The park's own copy, including what's served. Facts only; we don't store the prose. |
| `search_tags`, `images` | Search keywords and the app's photos. |

Two of the 19 are `archived` (Station Restaurant, Coffee Station), which is
better history than waiting for an outlet to vanish from a later bundle: the
sync records them with `appMissingSince` set to the day the park archived them.

Only 2 outlets carry a themed-area tag, so the rest take the area of the nearest
POI that has one (within 150m). A land's average position is a poor test in a
park this compact, where the areas interlock.

### 7.2 What they sell — `menus.tenkites.com/paultonspark/<slug>`

Each `menu` URL is a Tenkites digital menu board: course headings, dishes,
descriptions, calories and the park's vegetarian/vegan marks.

**There are no prices.** Tenkites renders a `k10-recipe__price` element for
every dish and Paulton's leaves every one of them empty, on all 18 boards. So
these menus are stored with `unpriced: true` and the prices come from elsewhere
(Theme Park James, who photographed the boards in the park — see
`contrib/menus/README.md`).

The slug is a fossil of an older name on four outlets: `beastiebites` is now
Churros, `cascades` is now Doughnuts, `therailroaddiner` is Fish & Chips and
`thequeenskitchen` is the Pancake Kitchen. That is how those venues' older menus
were matched to today's folders. Three boards (`coffeestation`, `thesnakepit` and the archived
`stationrestaurant`) are live pages with no dishes on them.

Markup notes for the parser (`scripts/menus/import-tenkites.mjs`): class
attributes wrap across lines, so selectors match a class inside the list rather
than the whole attribute; `k10-course__name-text` opens a section,
`k10-recipe__name` is a dish (not `k10-recipe__name-wrapper`), the description
is `k10-recipe__desc`, calories are `k10-primary-nutrient__item` ("941 cal") and
the dietary mark is `k10-recipe__label` ("V").
