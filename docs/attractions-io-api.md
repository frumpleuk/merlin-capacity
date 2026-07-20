# Attractions.io (“Occasio”) Ride-Data API — Reference

A complete description of how the backend that powers the official Alton Towers,
Thorpe Park, Chessington, and LEGOLAND Windsor Android apps exposes ride names,
height/age limits, live queue times, and operational status.

This document describes **only how the API works**. It intentionally contains no
scraping, storage, scheduling, or presentation logic.

All four apps are built on the same platform — **Attractions.io** (the client SDK
is internally named *Occasio*). Every park is one “application” on that platform,
identified by a UUID **api-key**. The API surface, data model, and auth are
identical across parks; only the api-key and content differ.

Facts below were obtained by decompiling the apps and exercising the live
endpoints. Where a field’s meaning is inferred from its name or app code rather
than directly observed, it is marked *(inferred)*.

---

## 1. Parks

| Park | Android package | Slug | api-key (UUID) |
|---|---|---|---|
| Alton Towers | `com.thrillseeker.altontowers` | `alton-towers-resort` | `e6c2bbf8-da54-47a2-a5ed-8b7797137113` |
| Thorpe Park | `io.attractions.thorpepark` | `thorpe-park` | `a070eedc-db3a-4c69-b55a-b79336ce723f` |
| Chessington | `thrillseeker.app.chessington` | `chessington` | `307f27cd-2be1-4b43-aee8-7832cfadb85f` |
| LEGOLAND Windsor | `com.merlin.legowi` | `legoland-windsor` | `7b56aa91-d4c6-4f8f-bac6-441a141a8e81` |

- **api-key** — a per-park UUID embedded in the app (`BuildConfig.API_KEY`). It is
  a public client identifier, not a secret. It is used in two places: as the
  filename of the live feed, and inside the `Authorization` header.
- **slug** — the app’s `WEB_LINK_DOMAIN` (`<slug>.app.attractions.io`). Used in the
  content-bundle URL path and as the per-park web/deep-link host.

---

## 2. Hosts

| Host | Purpose | Auth |
|---|---|---|
| `https://live-data.attractions.io/` | Live queue times / operational status | **None** |
| `https://api.attractions.io/` | Installation registration, content-bundle pointer | api-key (+ installation-token) |
| `https://s3-eu-west-1.amazonaws.com/attractions-io-production-app-data-bundles/` | Full content bundles (zip) | **None** (public bucket) |
| `https://cdn.attractions.io/` | Content **delta** bundles (zip) | **None** *(reached via redirect)* |
| `https://auth.attractions.io/` | End-user account OAuth (login, tickets) | Out of scope |

The API also has a `/v2/` namespace (payments/Adyen) and a `/v3/events` endpoint
(analytics). Neither is needed for ride data and both are out of scope here.

---

## 3. Data model

There are **two data sources** that share one key space and are meant to be
merged:

1. **Static content** — names, height/age limits, categories, geometry. Changes
   rarely (only when the park’s content team publishes). Delivered as a
   downloadable **content bundle** (§6). Also shipped inside the APK at
   `assets/data/` as a seed snapshot, but that snapshot goes stale.
2. **Live feed** — per-attraction operational status and current wait time.
   Changes continuously. Delivered as a single JSON file (§5).

Both are keyed on the same integer `_id`. **The live feed carries no names; the
static content carries no live status. You join them on `_id`.**

### 3.1 Entities

| Entity | Meaning |
|---|---|
| `Resort` | The park itself (opening times). |
| `Item` | A point of interest — ride, show, shop, restaurant, facility. Rides are a subset of Items. |
| `QueueLine` | A queue attached to an Item. An Item can have several (main, single-rider, etc.). |
| `Category` | Grouping/label for Items (e.g. themed area or ride type). |
| `Classification` | Tag applied to Items (themed land, thrill level, wait-time class). |
| `Area`, `Entrance`, `Image`, `Offer`, `CallToAction`, `InfoGroup`/`InfoItem`, `ShopItem`, `Food*`, `Commerce*` | Other content types; not required for ride data. |

### 3.2 `Item` — static fields (from the content bundle)

Real example (Alton Towers, Nemesis Sub-Terra):

```json
{
  "_id": 22355,
  "Name": "Nemesis Sub-Terra",
  "AbbreviatedName": null,
  "Summary": "Embark on an intense journey underground …",
  "Location": "52.987592493579,-1.8841530585135",
  "Category": 507,
  "Classifications": [119],
  "MinimumHeightRequirement": 1.4,
  "MinimumUnaccompaniedHeightRequirement": null,
  "MaximumHeightRequirement": null,
  "MinimumAgeRequirement": null,
  "MinimumUnaccompaniedAgeRequirement": null,
  "MaximumAgeRequirement": null,
  "RestrictionSummary": "If your height is less than 1.4 m, then you cannot ride.",
  "RestrictionSummaryContent": "e7e6f0b6-9d40-5017-8896-130649e49c52",
  "DefaultImage": 59249,
  "Featured": false,
  "WayfindingEnabled": true,
  "VisibleOnMap": true,
  "Parent": null,
  "RelatedItems": [4190],
  "CallToActions": ["39a314d8-…", "a14d6675-…"]
}
```

Key fields for ride data:

| Field | Type | Notes |
|---|---|---|
| `_id` | int | Primary key; the join key to the live feed. |
| `Name` | string | Display name. |
| `AbbreviatedName` | string / null | Short name if set. |
| `Summary` | string | Description. |
| `Location` | string | `"lat,long"` (comma-separated, single string). |
| `Category` | int | → `Category._id`. |
| `Classifications` | int[] | → `Classification._id[]` (themed land, thrill level, etc.). |
| `MinimumHeightRequirement` | float / null | **Metres.** e.g. `1.4`. |
| `MinimumUnaccompaniedHeightRequirement` | float / null | Metres; ride alone above this, with adult below. |
| `MaximumHeightRequirement` | float / null | Metres. |
| `MinimumAgeRequirement` / `MinimumUnaccompaniedAgeRequirement` / `MaximumAgeRequirement` | int / null | Years. |
| `RestrictionSummary` | string / null | Human-readable restriction text. |
| `DefaultImage` | int / null | → `Image._id`. |
| `VisibleOnMap`, `WayfindingEnabled`, `Featured` | bool | UI flags. |

Non-ride Items (shops, food, facilities) share this shape but typically have null
height/age fields.

### 3.3 `QueueLine` — static fields

```json
{ "_id": 7, "Item": 4188, "Type": "physical_main" }
```

| Field | Type | Notes |
|---|---|---|
| `_id` | int | Primary key; join key for the live `QueueLine` records. |
| `Item` | int | → `Item._id` the queue belongs to. |
| `Type` | string | Queue kind, e.g. `physical_main`. Other types (single-rider, virtual/fastrack) may appear. |

Deriving “rides”: the set of Items referenced by any `QueueLine.Item` is a good
definition of *attractions that have a queue*. (A few `QueueLine.Item`
references may point at Items absent from your current static snapshot — treat
those as “refresh needed”, see §7.)

### 3.4 `Classification` and `Category`

```json
{ "_id": 119, "Name": "Thrills", "Icon": "c379b51c-…" }   // Classification
```

`collections.json` (shipped alongside `records.json`) groups these into named
sets the app uses for filtering, e.g.:

```json
[
  {"name":"AttractionCategories","members":[2347,3679,2585,3591,498, …]},
  {"name":"WaitTimeClassifications","members":[119,120,935]}
]
```

---

## 4. Authentication

### 4.1 Credentials

- **api-key** (per park, §1) — always required.
- **installation-token** (UUID) — required for `api.attractions.io` calls
  (registration excepted). Represents one registered “installation”. Obtained
  from §4.3, cached, and reused indefinitely.

The **live feed** (§5) and the **content bundles** (§6) require **no credentials
at all**. The installation-token is only needed to obtain the *pointer* to the
current content version (§6.2).

### 4.2 Authorization header format

```
Authorization: Attractions-Io api-key="<API_KEY>", installation-token="<TOKEN>"
```

For the registration call, the `installation-token` part is omitted:

```
Authorization: Attractions-Io api-key="<API_KEY>"
```

### 4.3 Registering an installation

```
POST https://api.attractions.io/v1/installation
Authorization: Attractions-Io api-key="<API_KEY>"
Idempotency-Key: <uuid>
Content-Type: application/x-www-form-urlencoded

device_identifier=123
user_identifier=<uuid>
app_build=<int>
app_version=<string>
```

Body fields (as the app sends them):

| Field | Value in app | Notes |
|---|---|---|
| `device_identifier` | `"123"` (hardcoded constant) | Not a real device id; any stable value works. |
| `user_identifier` | random UUID, generated once and persisted per install | This is the identity the installation is bound to. |
| `app_build` | `BuildConfig.VERSION_CODE` (int) | Not validated strictly in testing. |
| `app_version` | `BuildConfig.VERSION_NAME` (string) | Not validated strictly in testing. |

Response:

```
201 Created
{ "token": "778a726c-56f4-47b2-af4f-20ba1201c832" }
```

The `token` is a UUID. Store it and reuse it. If any authenticated call returns
`authorization_unknown_installation`, the token is dead — re-register.

### 4.4 Common errors

| HTTP | `flags` | Cause |
|---|---|---|
| 401 | `authorization_error`, `authorization_invalid_key` | Missing/incorrect credentials for the endpoint (e.g. api-key only where a token is required). |
| 400 | `invalid_date_header` | `/v1/data` called without a valid `Date` header. |
| — | `authorization_unknown_installation` | Installation token no longer recognised; re-register. |

---

## 5. Live feed — queue times & status

```
GET https://live-data.attractions.io/<API_KEY>.json
```

- No auth, no headers required. `Content-Type: application/json`.
- One file per park; the api-key is the filename.
- Small (tens of KB) and updated frequently. It is a **status overlay** meant to
  be applied on top of the static content, not a standalone catalogue.

### 5.1 Envelope

```json
{
  "entities": {
    "Resort":    { "type": "attributes", "records": [ … ] },
    "Weather":   { "type": "replace",    "records": [ … ] },
    "Item":      { "type": "attributes", "records": [ … ] },
    "QueueLine": { "type": "attributes", "records": [ … ] },
    "Offer":     { "type": "attributes", "records": [ … ] }
  }
}
```

- `type: "attributes"` — patch these attributes onto the matching static records
  (by `_id`).
- `type: "replace"` — replace the whole collection with what’s given (empty list
  = clear).
- Which entities appear varies by park and moment (e.g. `Weather`/`Offer` may be
  empty or absent).

### 5.2 `Item` live record

```json
{
  "_id": 4193,
  "IsOperational": true,
  "IsOpen": true,
  "QueueTime": 45,
  "QueueStatusMessage": null,
  "OpeningTimes": "{\"type\":\"range\",\"start\":\"2026-07-18 10:00:00\",\"end\":\"2026-07-18 18:00:00\"}"
}
```

| Field | Type | Meaning |
|---|---|---|
| `_id` | int | → `Item._id` (join to static for name, height, etc.). |
| `IsOperational` | bool | Ride is in service today / not broken-down or closed for the season. |
| `IsOpen` | bool | Currently open to guests right now. |
| `QueueTime` | int / null | **Posted wait in SECONDS** — verified against an open park: values are always multiples of 300 (5-minute steps), e.g. `5400` = 90 min, `3600` = 60 min. Despite the field name it is *not* minutes. `null` when closed or not reporting. |
| `QueueStatusMessage` | string / null | Text shown instead of/next to a number. Observed: `null`, `"CLOSED"`. Other values (e.g. capacity/breakdown states) are likely but were not observed. |
| `OpeningTimes` | string (JSON) | Embedded JSON, see §5.4. |

> Capture note: the original data collection was outside opening hours, so every
> `QueueTime` was `null`. A later open-park sample resolved the unit: `QueueTime`
> is **seconds** (all values are multiples of 300), not minutes as the field name
> suggests — divide by 60 for the posted wait in minutes.

### 5.3 `QueueLine` live record

```json
{ "_id": 123, "QueueTime": null, "QueueStatusMessage": "CLOSED" }
```

| Field | Type | Meaning |
|---|---|---|
| `_id` | int | → `QueueLine._id` → (static) `QueueLine.Item`. |
| `QueueTime` | int / null | Wait in **seconds** for **this specific queue line** (same unit as the Item-level field above — divide by 60 for minutes). |
| `QueueStatusMessage` | string / null | As above. |

This is how attractions with multiple queues are represented: the per-Item record
gives an overall figure; the per-QueueLine records give each line (e.g. main vs
single-rider). Resolve a QueueLine to its ride via static `QueueLine.Item`.

### 5.4 `Resort` live record & `OpeningTimes` format

```json
{ "_id": 49, "OpeningTimes": "{\"type\":\"range\",\"start\":\"2026-07-18 10:00:00\",\"end\":\"2026-07-18 18:00:00\"}" }
```

`OpeningTimes` is a **JSON string** (must be parsed a second time). Observed
shape:

```json
{ "type": "range", "start": "YYYY-MM-DD HH:MM:SS", "end": "YYYY-MM-DD HH:MM:SS" }
```

Times are local park time, no timezone suffix. `type` other than `range` may
occur (e.g. closed days); only `range` and `null` were observed.

---

## 6. Static content — names, heights, catalogue

### 6.1 The bundle

A zip archive containing the full content database for one park version.

**Internal layout (root of the zip):**

```
collections.json          # named groupings of ids (filters, categories)
manifest.json             # { "version": "<ISO8601>", "hashes": { "media": { "<uuid>": "<sha1>", … } } }
records.json              # the catalogue: { "Item": [...], "QueueLine": [...], "Classification": [...], … }
media/<uuid>/manifest.json
media/<uuid>/<binary assets>
```

`records.json` is a dict keyed by entity name; each value is a list of records in
the shapes described in §3. This is the authoritative source of `Name`,
`Minimum/MaximumHeightRequirement`, ages, categories, and geometry.

`manifest.json.version` is an **ISO-8601 timestamp** and doubles as the content
**version cursor** used for change detection and deltas (§7).

### 6.2 Getting the current bundle URL

```
GET https://api.attractions.io/v1/data
Authorization: Attractions-Io api-key="<API_KEY>", installation-token="<TOKEN>"
Date: <RFC 1123 GMT, e.g. "Sat, 18 Jul 2026 23:00:28 GMT">
```

- Minimal required headers: `Authorization` (full) and a valid `Date`. (The app
  also sends `Idempotency-Key` and several `Occasio-*` headers, but they were not
  required in testing.)
- Response: **`303 See Other`** with a `Location` pointing at the full bundle:

```
https://s3-eu-west-1.amazonaws.com/attractions-io-production-app-data-bundles/app-data/<slug>/versions/<version>.zip
```

That S3 URL is **public and unsigned** — it can be fetched directly with no auth
once known. The authenticated `/v1/data` call is, in effect, just the way to
learn the current `<version>`.

### 6.3 Delta bundles

If you pass your currently-held version:

```
GET https://api.attractions.io/v1/data?version=<your-current-version>
```

- If nothing changed: no new content (up to date).
- If newer content exists: `303` to a **delta** bundle on a different host:

```
https://cdn.attractions.io/deltas/<slug>/<from-version>_<to-version>.zip
```

e.g. `…/deltas/alton-towers-resort/2026-04-09T13:41:14Z_2026-07-18T08:58:06Z.zip`.
A delta contains only changed/added/removed records between the two versions.
Requesting `/v1/data` with **no** `version` always yields the full current
bundle.

### 6.4 Per-park bundle URLs (full, current at time of writing)

| Park | Full bundle URL |
|---|---|
| Alton Towers | `…/app-data/alton-towers-resort/versions/2026-07-18T08:58:06Z.zip` |
| Thorpe Park | `…/app-data/thorpe-park/versions/2026-07-18T11:47:47Z.zip` |
| Chessington | `…/app-data/chessington/versions/2026-07-18T17:18:29Z.zip` |
| LEGOLAND Windsor | `…/app-data/legoland-windsor/versions/2026-07-18T08:18:45Z.zip` |

(Prefix: `https://s3-eu-west-1.amazonaws.com/attractions-io-production-app-data-bundles`.)
Version strings change whenever the park republishes; resolve the current one via
§6.2 rather than hardcoding.

---

## 7. Change detection (new / removed rides)

Two independent signals; the bundled APK snapshot is **not** one of them.

1. **New content version.** Poll `/v1/data?version=<held>` (§6.3). A `303`
   means the catalogue changed; download the (delta or full) bundle and re-read
   `records.json`. Diffing the new `Item` set against the old surfaces added and
   removed attractions with full metadata. *(Verified: the April APK snapshot had
   189 Items; the July live bundle had 202 — the diff cleanly showed added items
   and one removed, e.g. a new “Minecraft” hub appearing and “Guest Services”
   gone.)*

2. **New/removed ids in the live feed.** The live `Item`/`QueueLine` records
   enumerate the ids the platform is currently tracking. An id you don’t
   recognise appearing (or a known one disappearing) flags a change immediately,
   with no bundle download — you just won’t have the name/height until you refresh
   the static content via (1). Note the live feed generally lists **more** ids
   than the content bundle (it includes status for facilities without full
   content records), so treat “unknown id” as “possibly needs a content refresh”.

---

## 8. Join model (summary)

```
Live Item._id            ─┐
                          ├─► Static Item._id  → Name, heights, ages, category, location
Live QueueLine._id ─► Static QueueLine._id ─► .Item ─► Static Item._id
```

- Name / limits: `static Item` keyed by `_id`.
- Overall live status/wait: `live Item` keyed by same `_id`.
- Per-queue live wait (main / single-rider): `live QueueLine._id` → `static
  QueueLine.Item` → `Item`.
- “Rides” ≈ Items referenced by any `QueueLine.Item`, or Items whose
  `Classifications`/`Category` place them under attraction categories in
  `collections.json`.

---

## 9. Behavioural notes & caveats

- **Closed-hours nulls.** Outside opening hours `QueueTime` is `null` and
  `IsOpen`/`IsOperational` are `false`. Absence of a number ≠ zero wait.
- **Units.** Heights are metres (float); ages are years (int). `Location` is a
  single `"lat,long"` string.
- **Live feed is an overlay.** Records are partial patches (`type:"attributes"`);
  don’t treat a live `Item` record as a full Item.
- **ids are per-park.** The same integer id means different things in different
  parks. Never mix id spaces across parks.
- **Version strings are timestamps** but should be treated as opaque cursors.
- **Undocumented / private API.** None of this is a published API. Endpoints,
  hosts (including the public S3/CDN bundle paths), and payloads can change
  without notice. The api-keys are app-embedded client identifiers, not
  entitlements.
- **Credentials footprint.** Only `/v1/data` needs a token; mint one once and
  reuse it. The live feed and bundles are unauthenticated.
- **Content vs status cadence.** Static content changes on the order of
  days/weeks (version bumps); live status changes continuously. They warrant very
  different refresh rates.

---

## 10. Endpoint quick reference

| # | Method | URL | Auth | Returns |
|---|---|---|---|---|
| Live | GET | `live-data.attractions.io/<key>.json` | none | Status/queue overlay JSON |
| Register | POST | `api.attractions.io/v1/installation` | api-key | `{ token }` (201) |
| Version pointer | GET | `api.attractions.io/v1/data[?version=<cur>]` | api-key + token + `Date` | `303` → bundle URL |
| Full bundle | GET | `s3-eu-west-1.amazonaws.com/attractions-io-production-app-data-bundles/app-data/<slug>/versions/<version>.zip` | none | Content zip |
| Delta bundle | GET | `cdn.attractions.io/deltas/<slug>/<from>_<to>.zip` | none | Delta zip |

**Sequence to get everything for one park:**
`POST /v1/installation` (once, cache token) → `GET /v1/data` → follow `303` →
download & unzip bundle → read `records.json` (names/limits) → then poll
`GET live-data.attractions.io/<key>.json` for live status, joining on `_id`.
