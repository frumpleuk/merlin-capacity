# Blackpool Pleasure Beach Queue-Times API — Reference

How the official **Pleasure Beach Resort** app exposes live ride queue times,
ride categorisation, and park opening hours. Blackpool Pleasure Beach is an
**independent** park (NOT Merlin), so this is yet another backend — different from
the accesso ticketing (`docs/accesso-api.md`), the Attractions.io live feed
(`docs/attractions-io-api.md`), Paulton's First Option Software backend
(`docs/paultons-api.md`), and Flamingo Land's Firebase Firestore
(`docs/flamingoland-api.md`).

Facts below were obtained by decompiling the Android app
(`com.bpb.pleasurebeach`, v3.2.3) and exercising the live endpoints.

---

## 1. App shape

Unlike Paulton's/Flamingo Land (Capacitor web apps), this is a **native Flutter
app**. The Dart code is AOT-compiled into `lib/arm64-v8a/libapp.so`, so there is
no JS bundle to read — the endpoint list and header names were recovered with
`strings` over `libapp.so`. Firebase is present but only for analytics/cloud
messaging (`AIzaSyBVe1A0eVFHmypVa4jqt1Wx1lJvqt7LSmE`, project number
`57025524556`); it is **not** used for the ride data.

All ride/park data comes from a **bespoke Laravel REST API**:

```
https://today.blackpoolpleasurebeach.com/api/app/v3
```

---

## 2. Backend & auth

| | |
|---|---|
| **Backend** | Bespoke Laravel API at `today.blackpoolpleasurebeach.com/api/app/v3` |
| **Auth** | Per-user **Laravel Sanctum** bearer token — everything except `/version` is behind `auth` middleware |
| **Unauthenticated** | `302` redirect to `/login` (an HTML redirect page, not JSON) |

This is the key difference from the other queue-only parks: there is **no
app-embedded static token** (Paulton's) and **no anonymous auth** (Flamingo Land).
The app authenticates a **real user account** and calls the API with that user's
token. So the integration needs one dedicated account whose token is cached and
refreshed on expiry/`401`.

### Cloudflare / User-Agent gotcha

The API host is behind Cloudflare with a WAF rule that **403s desktop-browser
User-Agents** — it expects the mobile app. Send the app's own UA
(`PleasureBeachResort/3.2.3 (Android)`); a `Mozilla/…` desktop UA is blocked with
a `403` HTML page *before* reaching Laravel (a valid request otherwise 422s on
validation). This is the **opposite** of the marketing-site scrape (§6), which
*requires* a browser header set — so the two BPB sources use different UAs. The
block is UA-based, not IP-based, so a Cloudflare Worker passes as long as it sends
the app UA.

### Public bootstrap (no auth)

```
GET /api/app/v3/version
→ { "required": "3.2.0", "recommended": "3.2.3", "pomvom_status": true }
```

Useful as a liveness check; nothing else is readable unauthenticated.

### Logging in

```
POST /api/app/v3/login
     Content-Type: application/json          ← must be real JSON; a form body with a
     { "email": "...", "password": "..." }      JSON content-type is parsed as empty → 422

→ 200 { "token": "<sanctum token>", "user_id": 1107582, "email": "...", "pomvom_id": null }
```

- `token` is a ~55-char Laravel Sanctum personal-access token (`<id>|<40 chars>`).
  Sanctum tokens don't expire by default — cache it and only re-login on a `401`.
- Send it on every read as `Authorization: Bearer <token>`.
- `/register` exists (`name`, `email`, `password`, `password_confirmation`,
  `terms`, `platform`) if a dedicated account is wanted instead; the email
  validator does a real-domain check (rejects `example.com`).

---

## 3. Ride queue times — `GET /queue-times`

```
GET /api/app/v3/queue-times
    Authorization: Bearer <token>
```

A genuine **live feed** (each poll is the current state — *not* Paulton's
last-known-state overlay). Returns a flat JSON array, one object per ride, name
and category **inline**. Currently 30 rides.

### Object shape (one per ride)

```json
{
  "id": 38,
  "rideId": 38,
  "treasury_ride_id": 40,
  "ride": "Valhalla",
  "message": "",
  "category": "Thrill Ride",
  "image": "https://appadmin.bpbltd.com/storage/rides/valhalla.jpg",
  "display": 5,
  "active": false,
  "holding": false,
  "closed": true,
  "queueTime": 0,
  "enabled": true,
  "latest_ride_time": {
    "ride_id": 38,
    "date": "2026-07-22",
    "open_time": "13:00:00",
    "close_time": "19:00:00"
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` / `rideId` | int | Ride id (same value). Our join/display key. |
| `treasury_ride_id` | int | A second id in the park's ticketing/"treasury" system. Unused here. |
| `ride` | string | Display name, e.g. `Valhalla`. Not HTML-encoded. |
| `category` | string | Ride grouping — inline. Values: **Thrill Ride**, **Family Ride**, **Nickelodeon Ride**. Used as the UI section. |
| `queueTime` | int | Posted wait in whole **MINUTES**. Reads `0` when the ride isn't open (see below). |
| `active` | bool | Ride is open/running now. |
| `closed` | bool | Ride is closed. (`active` and `closed` are complementary in every sample.) |
| `holding` | bool | Queue temporarily paused/held (transient stop) — none set in the captured sample. |
| `message` | string | Human-readable status text when closed, e.g. `"Sorry, this ride is closed…"`; empty otherwise. |
| `display` | int | App sort order (1..N). |
| `enabled` | bool | App flag; does **not** track open/closed (seen `false` on rides that were open and posting a wait). Not used for status. |
| `latest_ride_time` | obj / null | That ride's scheduled hours **for today** (`open_time`/`close_time`, 24h). `null` when the ride has no scheduled time (e.g. down all day). |

Other fields (`limit`, `vip`, `ones`, `one_price`, `easyPass`, `is_flex_pass`,
`flex_pass_price`, `showSpeedyOne`, `speedyOneQueueTime`, `restrictions`,
`ridePhotograpy`, `hasBooking`) are SpeedyPass/Flex-pass/photo commerce metadata —
irrelevant to queue tracking.

### Open / operational & wait handling

- **Open now** = `active && !closed`. When not open, treat the wait as **null**
  (`queueTime` reads `0` while closed, which is a closed signal, not a real
  0-minute wait).
- `holding` (queue paused) is a transient state; model it as open-but-waiting or
  fold it into not-running as preferred (none observed to calibrate).
- Because it's a live feed, wait nulling on close is safe — there is no
  last-known-state to preserve (contrast Paulton's).

---

## 4. Categorisation

Comes straight off the inline `category` field in `/queue-times` — a single
dimension matching the app's own grouping:

| Category | Count (2026-07-22) |
|---|---|
| Nickelodeon Ride | 12 |
| Thrill Ride | 11 |
| Family Ride | 7 |

No content bundle, POI file, or separate catalog call is needed (unlike Paulton's
embedded `points_of_interest.json`).

### Optional finer taxonomy — `GET /map/get-markers`

Not required, but available if a Paulton's-style second grouping dimension is ever
wanted. Returns 129 map markers (`type` ∈ attraction / food_drink / shows_events /
shopping / facilities / **ride** / hotel). The 30 `type:"ride"` markers link back
to a ride via `linkable_type: "App\\Rides"` + `linkable_id`, and carry richer
`filters` values (e.g. `Water Ride`, `Dark Ride`, `White Knuckle Ride`,
`Nickelodeon Land Ride`, `Family Ride`) than the 3 top-level categories. Each
marker also has `lat`/`lon`, `description`, `info_url`, `image_url`.

> ⚠️ `linkable_id` is in the `App\Rides` id space, which is **not** obviously the
> same as `/queue-times` `id`/`rideId`/`treasury_ride_id` — a join would need
> verifying by name before relying on it.

---

## 5. Park opening times — `GET /opening-times`

```
GET /api/app/v3/opening-times
    Authorization: Bearer <token>

→ {
    "open_date": "2026-07-22",
    "time_from": "10:00am",
    "time_to": "8:00pm",
    "is_peak": 1,
    "date_name": "Wed 22nd July",
    "price_from": "25.00", "price_to": "60.00",
    "individual_price": "60.00", "nickelodeon_price": "25.00", "non_rider_price": "18.00",
    "event_title": "10 hours of fun", "event_info": "…", "event_icon": "➕",
    "event_link": "https://www.blackpoolpleasurebeach.com/opening-times-prices/"
  }
```

- **Today only.** Strictly the current day: `?date=`/`?open_date=` are **ignored**
  (still returns today) and the path form `/opening-times/{date}` **404s**. The
  binary has exactly one `opening-times` endpoint — no calendar/month variant.
  Multi-day opening hours come from the **marketing site** instead (§6), not the
  app API. We use the app's `/opening-times` only implicitly — the same numbers
  appear per-ride in `/queue-times` `latest_ride_time`, from which the queue
  poller derives the day's park window for the sparkline x-axis.
- `time_from` / `time_to` are human strings (`"10:00am"` / `"8:00pm"`) — parse to
  a real time to drive the sparkline x-domain.
- This is a genuine win over Paulton's and Flamingo Land, which expose **no** park
  hours at all (their sparklines fall back to the data span). BPB gives a real
  daily open window. Per-ride hours are additionally available via each ride's
  `latest_ride_time`.

---

## 6. Multi-day opening calendar (park-dates-times JSON API)

The app API only ever gives *today*, but the bookings site exposes the full
forward calendar — opening hours, prices, and events per date — as a plain JSON
API. This is the source that feeds the marketing site's inline calendar widget
(see the scrape note below); reading it directly is cleaner than regexing HTML.

**Endpoint:** `GET https://bookings.blackpoolpleasurebeach.com/api/park-dates-times/v2`
→ a flat JSON array, one object per OPEN date. No auth, no query params.

Each entry is exactly the app's `/opening-times` shape (same backend, unsurprisingly):

```json
{
  "open_date": "2026-07-22",
  "time_from": "10:00am", "time_to": "8:00pm",
  "date_name": "Wed 22nd July",
  "is_peak": 1, "is_ten_day": 0,
  "price_from": "25.00", "price_to": "60.00",
  "individual_price": "60.00", "nickelodeon_price": "25.00",
  "event_title": "Twilight Thrills",
  "event_info": "Experience the park after dark…",
  "event_icon": "🌟",
  "event_link": "https://www.blackpoolpleasurebeach.com/events/twilight-thrills/"
}
```

| Field | Meaning |
|---|---|
| `open_date` | ISO date. **Only operating days are listed** — a date absent from the array is a closed/non-operating day. (One date can appear twice — dedupe by ISO, last wins; e.g. 2027-04-01 was duplicated in a 175-entry response → 174 days.) |
| `time_from` / `time_to` | Park open/close, human strings (`"10:00am"` / `"8:00pm"`). |
| `date_name` | Pretty label, e.g. `"Wed 22nd July"`. |
| `is_peak` / `is_ten_day` | Pricing/season flags (unused). |
| `price_*` / `*_price` | Admission prices (unused by us). |
| `event_title` + `event_info` + `event_icon` + `event_link` | Present on ~20% of days. **Filter on `event_link`:** a real event links to `…/events/<slug>/`; a marketing tag ("10 hours of fun") links back to `…/opening-times-prices/`. Only the former is surfaced as a calendar event badge. |

- **Range:** ~175–184 forward days (today → ~11 months out), refreshed as the park
  releases dates. **Forward only** — past dates drop off, so the poller freezes
  each month's file once its dates leave the window (same as the Merlin hours /
  availability freezing in `db.ts`).
- **Cloudflare bot-fight — needs real browser headers.** The host is behind
  Cloudflare. A `curl` from a residential IP gets **200** even with a thin
  request, but the same thin request (bare `accept` + a Chrome UA) from a
  **Cloudflare Worker** `fetch()` gets **403** — the WAF is stricter on
  worker-originated traffic. Sending a full modern-browser client-hint /
  fetch-metadata set (`sec-ch-ua`, `sec-ch-ua-platform`, `sec-fetch-*`, rich
  `accept`, `accept-language`) clears it → **200** from the Worker too. This is
  `BPB_API_HEADERS` in `src/hours.ts`, tuned for a JSON XHR (`sec-fetch-dest:
  empty`, `mode: cors`). Verified end-to-end via `wrangler dev` + `/poll` (174
  days). (Contrast the Merlin marketing sites, which only need a browser UA.)
- **Marketing-site alternative (not used).** The same data is also inlined into
  `https://www.blackpoolpleasurebeach.com/opening-times-prices/` as a
  `var wn_dates = [ … ]` JS array by a WordPress plugin (`wn-blackpool-time-price`,
  server-rendered, not AJAX). We formerly scraped that with a regex; the JSON API
  above supersedes it (no HTML parsing, one fewer failure mode).

---

## 7. Notes & caveats

- **Wait units.** `queueTime` is whole minutes.
- **Closed → `queueTime: 0`.** A live feed, so `0`-while-closed is a status
  artefact, not a real wait; null it unless `active && !closed`.
- **Auth is a real account.** Unlike every other queue-only park, reads require a
  logged-in user. The poller needs a stored credential (Cloudflare secret) or a
  cached Sanctum token, re-login on `401`.
- **Undocumented / private.** None of this is published; endpoints, fields, and
  the `v3` version can change without notice. The account token is a user
  credential, not an app-embedded client identifier — keep it out of the repo.
- **Sample was mid-open-day** (2026-07-22, park open 10:00–20:00), so open/closed
  states and live waits were both observed directly — no after-hours-only blind
  spot like the first Paulton's/Flamingo captures.

---

## 8. Integration (this repo)

Blackpool is a **calendar + queue** park — the only independent one with both
(Paulton's/Flamingo are queue-only): the queues come from the app API (§3) and the
opening calendar from the site scrape (§6).

**Queues.** A new `QueueSource` of `kind: "bpb"` (`src/config.ts`) + `src/bpb.ts`:
- Obtains/caches the Sanctum token — login with the account (creds from the
  `BPB_EMAIL`/`BPB_PASSWORD` Worker secrets, **not** in the repo), cached in R2 at
  `bpb/<park>/auth.json`, re-login on `401`.
- Reads `/queue-times` and normalises each row into the shared `QueueObs` model as
  one synthetic line keyed by `rideId` (`active && !closed` → running; wait nulled
  otherwise; a `closed` ride with no `latest_ride_time` today → a "Closed all day"
  note). Synthesises a `RideCatalog` from the inline `ride` names with `category`
  as the thrill group — persisted to R2 only when the name/group set changes (the
  `catalogNamesChanged` path shared with the `fos`/`firestore` backends).
- Derives the day's park window (sparkline x-axis) from the min/max of the rides'
  `latest_ride_time` open/close — no extra request.

`runQueuePoll` gains a `kind==="bpb"` branch; it's an inline-name backend like
`fos`/`firestore`, so it's excluded from the Attractions.io catalog cron and rides
the every-minute queue cron. The frontend catalog marks it `liveClosed` (the feed
is authoritative, so a shut ride reads "Closed", not "Closed all day").

**Calendar (opening hours).** `park.openingHours` is now a discriminated union —
`{ kind: "accesso", … }` (the Merlin `getcalendar` API) or `{ kind: "bpb", pageUrl }`
(this scrape). `src/hours.ts` branches on it: the `bpb` arm GETs the page with the
browser-header set (§6), extracts `wn_dates`, and maps each entry to the shared
`HoursSnapshot` (one themepark location per day, `"10am - 8pm"`, plus a real event
when `event_link` is an `/events/` URL). Everything downstream — the per-month
hours files, freezing, and the Calendar tab — is reused unchanged. The frontend
park def has `products: []` and is **not** `queueOnly`, so it shows both a Calendar
tab (hours only, no availability) and a Queues tab.

See `docs/apk-download.md` for how the APK was obtained (browser download +
`strings` over the Flutter `libapp.so`).
