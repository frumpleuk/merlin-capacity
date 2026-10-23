# Drayton Manor app API (accesso TE2)

Drayton Manor's app (`com.accesso.draytonmanor`, Expo/React Native, Hermes
bundle) runs on accesso's TE2 platform, the same family as the Gold Coast parks
in ThemeParks/parksapi (`src/parks/te2`). Its old Attractions.io bundle
(`app-data/drayton-manor/`) has had no new version since 2022-02-02.

Code: `src/te2.ts`. Found 2026-10-23 from the APK pulled off a phone with adb.

## App config

In the Hermes bundle as `draytonManorConfig` (decompile with
`hbc-decompiler` from `pip install git+https://github.com/P1sec/hermes-dec`, then
grep the output for `discoveryUrl`):

| Field | Value |
| --- | --- |
| API host | `https://api.us.te2.io`, paths under `/api/` |
| Discovery | `https://api.us.te2.io/global-auth` (`.well-known/openid-configuration`) |
| Token endpoint | `https://api.us.te2.io/global-auth/oauth2/token` |
| Client id | `ngap_dmr_prod` |
| Client secret | in the bundle; Worker secret `APP_KEY_DRAYTON_MANOR` |
| Venue / app id | `DMR_BG` |
| Customer id | `dmr` |
| Scopes | `openid service.all` |

## Auth

Anonymous OAuth token, valid one hour:

```
POST /global-auth/oauth2/token
Authorization: Basic base64(clientId:clientSecret)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:accesso:oauth2:grant-type:anonymous&scope=anonymous openid service.all
```

- Without `service.all` in the scope the API answers 401 "Required JWT claim
  was not asserted".
- Each grant creates a new guest identity (`sub`), so the worker caches the
  token in R2 (`te2/DMR_BG/token.json`) and mints a new one only within five
  minutes of expiry or after a 401.
- Requests send `Authorization: Bearer <access_token>`, `appID: DMR_BG` and
  `X-Customer-ID: dmr`, as the app does.

## Endpoints

| Path | What |
| --- | --- |
| `v1/public/venues/DMR_BG/pois/` | Every POI (76): label, tags, details, location. 220 KB. |
| `v1/public/venues/DMR_BG/pois/status` | Live state per POI: `{isOpen, operationalStatus, waitTime, lastChanged}`. |
| `v2/venues/DMR_BG/venue-hours?days=N` | One slot per date, OPEN or CLOSED. `days` at most 365; about 65 days are published. |
| `v2/venues/DMR_BG/calendars/events?days=N` | Named events (`events[]`) and their date ranges (`schedules[]`, end exclusive). |

### POIs

- A ride has a `Ride Type` tag: Family, Coaster, Thrill or Water (40 POIs).
- `Height Required` values: `None`, `0.9m and over`, `1.05m and over`,
  `Maximum 1.3m`, `Under 0.9m`.
- `Age Restriction`: `2+`, `6+`.
- The area is `details[id=internalActivity].value.mountainArea` (Thomas Land,
  Frontier Falls, Adventure Cove, Main Street, Vikings; one ride says `Main`).
- 33 rides appear in the status feed with a `status`. The other 7 tagged rides
  have no area and no status and are left out.

### Status

- Overnight (01:00) every ride reads `operationalStatus: OPEN` with
  `isOpen: false` and no `waitTime`, so OPEN alone does not mean running.
- The worker counts a ride as running when `operationalStatus` is OPEN and
  `isOpen` is true, and DOWN as a breakdown.

### Hours

- A CLOSED day comes back as 00:00-23:59 and is left out of the calendar.
- Times are the park's wall clock whatever the suffix: winter dates carry `Z`,
  summer ones `+01:00`.
