# Paulton's Park Queue-Times API — Reference

How the official **Paulton's Park** app (home of Peppa Pig World) exposes live
ride queue times. Paulton's is an **independent** park — NOT Merlin — so this is
a wholly different backend from the accesso ticketing (`docs/accesso-api.md`) and
the Attractions.io live feed (`docs/attractions-io-api.md`) the Merlin parks use.

Facts below were obtained by decompiling the Android app
(`thrillseeker.app.paultons`) and exercising the live endpoint.

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
| `statusOpen` | bool | Open to guests now. The only open/closed signal (no separate "operational"). |
| `queueTime` | int / null | Posted wait. **Appears to be whole MINUTES** (values seen: 15, 20 — not the seconds the Attractions.io feed used). **Verify on an open day** — the first capture was after hours with everything closed. |
| `seats` | int / null | Ride capacity/seats (unused here). |
| `updatedAt` | string | ISO-8601 (UTC) of the last status change for this ride. Long-inactive rides keep a stale timestamp (e.g. a 2025 date). |
| `ride.name` | string / null | Display name. |

---

## 4. Notes & caveats

- **Names are inline** → there is no content bundle to download/unzip and no
  daily catalog cron. The catalog is synthesised from the feed each poll.
- **Closed-hours values.** When `statusOpen` is false, `queueTime` may still
  carry a stale number; treat the wait as meaningful only while open.
- **Defunct rides linger.** Rows with a months-old `updatedAt` (e.g. removed
  shows) still appear, `statusOpen:false`. They currently render as closed-all-day;
  a future refinement could filter by `updatedAt` freshness or a POI category.
- **No park hours** in this feed (the Attractions.io feed carried a `Resort`
  opening window). The sparkline x-axis falls back to the data span.
- **Undocumented / private API.** None of this is published; the host, path, and
  token can change without notice. The token is an app-embedded client
  identifier, not an entitlement.

---

## 5. Integration (this repo)

Modelled as a `QueueSource` of `kind: "fos"` (`src/config.ts`). `src/firstoption.ts`
fetches `/api/queue-times`, normalises each row into the shared `QueueObs` model
as a single synthetic queue line keyed by `rideId` (`statusOpen` → is_open &
is_operational; wait nulled when closed), and synthesises a `RideCatalog` from the
inline names (persisted to R2 only when the name set changes). Everything
downstream — D1 `queue_observation`, day-file generation, the Queues tab — is
reused unchanged. Paulton's rides the existing every-minute queue cron and is
excluded from the Attractions.io catalog cron.
