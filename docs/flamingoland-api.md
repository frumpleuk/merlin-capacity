# Flamingo Land Queue-Times API — Reference

How the official **Flamingo Land Resort** app exposes live ride queue times.
Flamingo Land (Malton, North Yorkshire) is an **independent** park — NOT Merlin —
so this is a different backend again from the accesso ticketing
(`docs/accesso-api.md`), the Attractions.io live feed
(`docs/attractions-io-api.md`), and Paulton's First Option Software backend
(`docs/paultons-api.md`).

Facts below were obtained by decompiling the Android app
(`com.flamingoLandResort.visitorApp`, v3.0.4) and exercising the live endpoint.

---

## 1. App shape

Like Paulton's, the app is a **Capacitor hybrid web app** — the UI is a bundled
Angular/Ionic web app under `assets/public/` and all config lives in its JS, not
in Android resources. The ride list and its live waits are read straight from a
**Firebase Cloud Firestore** database via the Firebase Web SDK
(`this.firestore.collection("rides_data")`). There is no bespoke REST API and no
Attractions.io live feed.

---

## 2. Backend & auth

| | |
|---|---|
| **Backend** | Firebase Cloud Firestore, project **`flamingo-land-app`** |
| **Web apiKey** | `AIzaSyA2yrf4wI5a5oynBWu7ehjFzai-vtFr64Y` (app-embedded, in the env config block) |
| **Read transport** | Firestore REST API (`https://firestore.googleapis.com/v1`) |
| **Auth** | a Firebase **ID token** — reads are NOT public (unauthenticated → `403 PERMISSION_DENIED`) |

The security rules require `request.auth != null`, but the app enables
**anonymous auth**, so any client can obtain a token with just the public web
apiKey — no user credentials. This is the same class of app-embedded client
identifier as the accesso app-id or the Attractions.io api-key.

### Getting an anonymous token

```
POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<apiKey>
     {"returnSecureToken": true}
→ { idToken, refreshToken, expiresIn: "3600", localId, … }
```

`idToken` lasts ~1 hour. Refresh it (rather than signing up a new anonymous user
every poll) with:

```
POST https://securetoken.googleapis.com/v1/token?key=<apiKey>
     grant_type=refresh_token&refresh_token=<refreshToken>
→ { id_token, refresh_token, expires_in, … }
```

---

## 3. Reading the rides

```
GET https://firestore.googleapis.com/v1/projects/flamingo-land-app/databases/(default)/documents/rides_data
    ?pageSize=300
    &mask.fieldPaths=id&mask.fieldPaths=title&mask.fieldPaths=queue_time&…
    Authorization: Bearer <idToken>
```

- The **field mask** is important: the full docs carry each ride's description
  HTML, image URLs, restrictions, etc. (~137 KB for the collection). Masked to
  the fields below it's ~23 KB — worth it on a per-minute poll.
- Firestore's default page size is small (20), so set `pageSize` high **and**
  drain any `nextPageToken` (the collection is currently 32 docs → one page).

### Document shape (one per ride)

```json
{
  "fields": {
    "id":               { "integerValue": "672" },
    "externalId":       { "integerValue": "35" },
    "title":            { "stringValue": "Navigator" },
    "category":         { "stringValue": "Thrill Rides" },
    "queue_time":       { "integerValue": "0" },
    "statusOpen":       { "booleanValue": false },
    "underMaintenance": { "booleanValue": false },
    "downAllDay":       { "booleanValue": false },
    "displayIfClosed":  { "booleanValue": false },
    "isRide":           { "booleanValue": true }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | int | Ride id. Present on every doc → our join/display key (the Firestore doc-id is an opaque string). |
| `externalId` | int / absent | A second id (matches the queue-times.com ride numbering); absent on some rides. Unused here. |
| `title` | string | Display name. **HTML-entity encoded** (e.g. `Children&#8217;s Planet`) — decode it. |
| `category` | string | Ride grouping — "Thrill Rides", "Family Rides", "Kids Rides", "Other Attractions", "Getting Around". Used as the UI section. |
| `queue_time` | int / absent | Posted wait, in whole **MINUTES** (the app renders `"{queue_time} min"`). Absent on rides that never post a wait. |
| `statusOpen` | bool | Open to guests now. |
| `underMaintenance` / `downAllDay` | bool | Not operational when either is true. |
| `displayIfClosed` | bool | App display hint (unused here). |
| `isRide` | bool | Distinguishes rides from other POIs. |

---

## 4. Notes & caveats

- **Wait units.** `queue_time` is whole minutes (confirmed by the app template
  `{{ride.queue_time}} min`), NOT the seconds the Attractions.io feed used.
- **Stale-while-closed.** When a ride isn't running, `queue_time` may still carry
  the last posted number (seen: Hero/Velocity showing `30` at 00:00 with
  `statusOpen:false`). Treat the wait as meaningful only while **open &&
  operational**; null it otherwise. *(Live open-park values weren't captured —
  the first sample was after hours with everything closed.)*
- **No park hours** in the feed (no `Resort` opening window like Attractions.io).
  The sparkline x-axis falls back to the data span.
- **Non-reporting rides linger.** ~7 rides (transport, walk-throughs) carry no
  `queue_time` field; they render as closed-all-day, same as Paulton's defunct
  rows. A future refinement could filter them out.
- **Undocumented / private.** None of this is published; the Firestore project,
  collection, apiKey, and rules can change without notice. The apiKey is an
  app-embedded client identifier, not an entitlement; anonymous auth is a rule
  the park could disable.

---

## 5. Integration (this repo)

Modelled as a `QueueSource` of `kind: "firestore"` (`src/config.ts`).
`src/firebase.ts` obtains an anonymous ID token (cached + refreshed in R2 at
`firebase/<park>/auth.json`, so one anonymous user is reused rather than minting
~1440/day), reads the `rides_data` collection field-masked over the Firestore
REST API, and normalises each doc into the shared `QueueObs` model as a single
synthetic queue line keyed by `id` (`statusOpen` → is_open;
`underMaintenance`/`downAllDay` → is_operational; wait nulled unless running). It
synthesises a `RideCatalog` from the inline `title`s (with `category` as the UI
group), persisted to R2 only when the name set changes. Everything downstream —
D1 `queue_observation`, day-file generation, the Queues tab — is reused
unchanged. Flamingo Land rides the existing every-minute queue cron and is
excluded from the Attractions.io catalog cron.

See `docs/apk-download.md` for how the APK was obtained.
