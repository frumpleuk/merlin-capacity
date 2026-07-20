# The accesso ticketing API (as reverse-engineered)

All four Merlin parks tracked by this project — Alton Towers, Thorpe Park, Legoland
Windsor and Chessington World of Adventures — sell tickets through **accesso**'s
"Passport" ecommerce platform (an AngularJS SPA backed by the `meg-eu` API stack).
This project reads *availability* from it; nothing here books, holds, or pays for a
ticket.

Everything below was reverse-engineered from the public booking sites and their
network traffic. accesso publishes no contract for any of this, so treat it as
observed behaviour that can change without notice.

---

## 1. Hosts

| Host | Use | IP blocking |
|---|---|---|
| `ecomm.api.meg-eu.accessoticketing.com` | The central API. Everything we call. | **Does not block** datacenter / non-UK IPs — reachable from Cloudflare Workers. |
| `me-<park>.tickets.<park>.com` | Per-park booking sites (the SPA + a legacy per-park API). | Legacy per-park API hosts **503 non-UK / datacenter IPs**. Avoid. |

Always call the central `ecomm.api.meg-eu` host. The per-park subdomains matter only
as `origin` / `referer` values (below) and as where the SPA and its `bootstrap`
slug are discovered.

---

## 2. Authentication & headers

There is **none** in the traditional sense. The reads we use are **stateless**:
no `session_id`, `request_token`, `cart_id`, or `cart_key` is required — no
cart/session bootstrap call is needed first.

What *is* required is a set of static headers identifying the app and merchant.
Missing or wrong headers generally yield a `FAILED` status or an empty result
rather than a 401.

```
com-accessopassport-app-id: 1500
com-accessopassport-client: accesso26
com-accessopassport-language: en-gb
com-accessopassport-merchant-id: <merchant id, e.g. 800>
content-type: application/json;charset=UTF-8
origin:  https://me-<park>.tickets.<park>.com
referer: https://me-<park>.tickets.<park>.com/
user-agent: <a normal browser UA>
```

`application_id` is `1500`; the app version string seen in the wild is `6.31.6`.

---

## 3. Endpoints

Two request styles coexist on the same host:

- **`POST /api/request/<request_type_lowercased>`** — the JSON-RPC-ish app API.
  The URL path mirrors a `request_type` field in the body.
- **`GET /static-api/bootstrap?m=<SLUG>&l=en-gb`** — a static, cacheable catalog
  dump used to cold-start the SPA.

### 3.1 `GetMerchantPackageEventDates` — availability (the signal we poll)

`POST /api/request/getmerchantpackageeventdates`

Returns per-date availability for a set of packages you already know. It does
**not** enumerate packages — you must supply them (see the catalog endpoint for
discovery).

**Request body** (fields this project sends):

```jsonc
{
  "P": [                                   // packages to query
    { "CT": [{ "id": "14143", "qty": 1 }], // customer type(s) + qty
      "event_id": "2502",
      "id": "96905" }                      // package id
  ],
  "extra_movie": "",                       // "date" adds per-slot time data (RAP)
  "identify_customer_types": 1,
  "min_capacity": 0,                       // 0 => also return sold-out dates
  "display_zero_capacity": "1",            //   (that's where releases first show)
  "include_times": false,                  // true for timed products (RAP)
  "version": "2",
  "start_date": "2026-07-16",
  "end_date":   "2026-12-13",
  "request_type": "GetMerchantPackageEventDates",
  "_version": "6.31.6",
  "application_id": "1500",
  "merchant_id": "800",
  "machine_id": "500", "agent_id": "5", "user_id": "5",
  "device": "desktop", "language": "en-gb"
}
```

**Response** — `SERVICE.D[]`, **one entry per date** (the server merges the
packages you sent; `package_id` in an entry may be comma-joined, e.g.
`"112899,112896"`). No client-side summing across packages is needed.

```jsonc
{
  "SERVICE": {
    "status": "OK",                        // OK | FAILED | ...
    "D": [
      { "date": "2026-07-17",
        "package_id": "96905",
        "T": { "capacity": "18000",        // nominal ceiling / event yield
               "available": "3263",        // tickets left  <-- the key signal
               "used": "2297" } }          // sold
    ]
  }
}
```

Notes:
- `available` is the number we track. For main tickets `available + used < capacity`
  (there is slack in the yield); for RAP the pool is hard
  (`available + used == capacity`) and `capacity` grows as new batches release.
- `status: FAILED` when **every** package you sent is out of its validity window
  for the requested date range — see [§5 Seasonal rotation](#5-seasonal-rotation--the-failed-trap).

### 3.2 `static-api/bootstrap` — the public catalog (discovery)

`GET /static-api/bootstrap?m=<SLUG>&l=en-gb`

An **unauthenticated ~3 MB JSON** blob (no POST body, no session) that cold-starts
the SPA. It contains the merchant's *entire* catalog and is the correct source for
discovering package/event/customer-type ids instead of hand-capturing them.

Top-level keys include `merchantId`, `subdomain`, and the consolidated data blocks
`GetApplicationConsolidated`, `GetMerchantDetails`, `GetMerchantKeywords`,
`GetMerchantPackageList`.

**Packages** live at `GetMerchantPackageList.SERVICE.PS.P[]`. Each entry carries the
full selector triple plus metadata:

```jsonc
{
  "id": "96905",                    // package id
  "name": "1 Day Ticket",
  "package_class": "Daily Tickets", // grouping ("Daily Tickets", "Promotions", ...)
  "keyword": "WizardAdmissionDated,SnapWizardAdmission,...",
  "E": {                            // the event this package books against
    "id": "2502",                   //   event id
    "capacity": "18000",
    "name": "Alton Towers - Main Event - Yield"
  },
  "CT": [ { "id": "14143", ... } ]  // customer type(s)
}
```

So `id` + `E.id` + `CT[].id` is exactly the tuple `GetMerchantPackageEventDates`
needs, and exactly what [`src/config.ts`](../src/config.ts) hardcodes.

**The `m=` slug is not the subdomain.** Read it from the target park's landing-page
HTML (`.../` → search for `bootstrap?m=`). See the [park reference](#4-park-reference).

### 3.3 `GetMerchantPackageList` (POST) — a lighter, less useful sibling

`POST /api/request/getmerchantpackagelist` (body like §3.1 but
`"request_type": "GetMerchantPackageList"`).

Works keyed by numeric `merchant_id` for **all** parks, and returns the same package
list shape (`SERVICE.PS.P[]`) — **but** the package objects come back **without the
`E` (event) and `CT` (customer type) fields** (both `null`). Because the whole point
of discovery is the event/CT binding, prefer the `bootstrap` blob (§3.2). Use this
POST form only if you already know the event/CT and just want names/keywords.

---

## 4. Park reference

| Park | `merchant_id` | Booking origin | Bootstrap `m=` slug |
|---|---|---|---|
| Alton Towers | `800` | `me-twalton.tickets.altontowers.com` | `ME-TWALTON` |
| Thorpe Park | `105` | `me-tpr.tickets.thorpepark.com` | `ME-TPR` |
| Legoland Windsor | `700` | `me-llwindsor.tickets.legoland.co.uk` | `ME-LLWINDSOR` |
| Chessington | `6400` | `me-cwoa.tickets.chessington.com` | **`ME-WACHESSINGTON`** |

> Chessington gotcha: the `me-cwoa` origin still works for the *availability* call,
> but its bootstrap slug is **`ME-WACHESSINGTON`** (subdomain `me-wachessington`),
> **not** `ME-CWOA` — the latter returns HTTP 500 `{"e":"Error: No configuration
> found"}`. Same `merchant_id` 6400 either way.

### Products (event / customer-type per park)

These `event_id` + `customer_type` pairs are stable across the year; only the
**package ids** rotate (see §5).

| Park | Product | `event_id` | `customer_type` | In catalog? |
|---|---|---|---|---|
| Alton | Main | `2502` | `14143` | ✅ |
| Alton | RAP | `2531` | `14036` | ❌ not in bootstrap |
| Thorpe | Main | `2507` | `13621` | ✅ |
| Thorpe | RAP | `2658` | `14036` | ❌ |
| Legoland | Main | `2399` | `14209` | ✅ |
| Legoland | RAP | `2659` | `14036` | ❌ |
| Chessington | Main | `2506` | `231` | ✅ |
| Chessington | RAP | `2654` | `14036` | ❌ |

**Main tickets** are the standard dated day ticket: filter
`package_class == "Daily Tickets"` and the day-ticket `name` on the main event.
The name is park-specific — Alton/Thorpe/Chessington call it **`1 Day Ticket`**,
Legoland calls it **`Online Saver`**. (This is the `name` override in the
`discover` spec in `src/config.ts`.) Send each matched package with its **own**
customer type, not one fixed CT — some seasonal/offer variants only sell under
other CTs, and forcing a single CT drops those dates. The per-date
capacity/availability is the same regardless of which package/CT you ask through.

**Capacity/availability are event-level; `used` is per-package.** Every package
on an event reports the same `capacity` and `available` (the day's shared yield),
but `used` counts only that package/CT's own bookings. So `capacity - available`
is the reliable total-sold figure; a single package's `used` is not.

**Yield anchor — prebook packages fill the not-yet-on-sale gap.** The public day
ticket for an autumn season (Thorpe Fright Nights, Alton Scarefest, Chessington
Howl'o'ween) goes on general sale only weeks ahead, so months out those dates have
**no `Daily Tickets` package at all** and would show as gaps — even though the date
is open. Annual-pass **prebook** packages (`package_class` contains `Prebook`;
Alton's is `AP Prebook`) *are* on sale far ahead and report the same event yield,
so including them as an anchor keeps every open date populated. On dates where the
day ticket exists too, the anchor doesn't change the numbers. This is
`discover.anchorClassMatch` (default `"prebook"`) in `src/config.ts`.

**RAP** (Ride Access Pass) is **not present in the catalog** for any park — no
package has `CT 14036` or the RAP event id. RAP is sold through a separate flow, so
its ids must still be captured by hand from the booking site. RAP is `customer_type
14036` at every park.

---

## 5. Seasonal rotation & the `FAILED` trap

Main-ticket **package ids rotate by season**, while `event_id` + `customer_type`
stay constant. Last year's autumn/winter packages remain valid for *this* autumn's
dates — they just have no dates in a near-term (e.g. summer) window.

`GetMerchantPackageEventDates` returns `status: FAILED` only when **every** package
in `P[]` is out-of-window for the requested range. If even one is valid, you get
`OK` and the API uses whichever packages are valid per date.

Two ways to stay covered:

1. **Superset (what `config.ts` does today):** send current-season + last-season
   package ids together. Robust, but needs a manual refresh each rotation.
2. **Catalog discovery (preferred):** pull the park's `bootstrap` blob, filter
   `Daily Tickets` / `1 Day Ticket` on the main event, and collect *all* matching
   package ids. This is a self-maintaining superset — no manual curl when a season
   turns over. Only RAP still needs hand-maintained ids.

Worked example (Chessington, 2026-07-16): the config's main ids had gone stale and
the product was returning `FAILED`. The bootstrap listed event `2506` / CT `231`
with 30 current `1 Day Ticket` package ids; querying those returned `status: OK`
with 96 dates of availability (July → November; the park closes for winter).

---

## 6. Gotchas checklist

- Call the central `ecomm.api.meg-eu` host, never the per-park legacy API (it 503s
  non-UK IPs).
- `min_capacity: 0` + `display_zero_capacity: "1"` — otherwise sold-out dates
  vanish, and that's exactly where a fresh release first appears.
- One entry per date already merged server-side; `package_id` may be comma-joined.
- `FAILED` ≠ "gone forever" — usually just every package out-of-window (§5).
- Bootstrap slug ≠ subdomain (Chessington: `ME-WACHESSINGTON`).
- RAP is not discoverable via the catalog; keep its ids by hand.
- A blank autumn date is usually "public ticket not on sale yet", not a bug — the
  prebook yield anchor fills it; `capacity - available` is the true total sold.
- Nothing here is authenticated or contractual; expect drift and log poll status
  (the `poll_log` table) so a park silently going `FAILED` is visible.
