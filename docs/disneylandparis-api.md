# Disneyland Paris API: reference

How the official Disneyland Paris app gets live waits, ride metadata and park
hours. Two site entries share these sources: `disneyland_park` (activity id
`P1`) and `disney_adventure_world` (`P2`). Code: `src/dlp.ts`.

Found by decompiling the Android app (`fr.disneylandparis.android` 7.17.1, an
APKPure XAPK) and calling the live endpoints. Checked 2026-10-21.

## 1. App shape

React Native (Expo SDK 53) with the JS compiled to Hermes bytecode
(`assets/index.android.bundle`, Hermes v96). `strings` on the bundle shows
URLs and GraphQL query text, but its string table is packed, so headers and
keys run into neighbouring strings. `hbc-disassembler` (pip `hermes-dec`)
resolves them: function `fetch_wait_times` sets the route and the
`x-api-key` header as literals.

`assets/www/AppConfig`, `AppData` and `AppCache` are encrypted blobs and were
not needed.

## 2. Wait times

```
GET https://dlp-wt.wdprapps.disney.com/prod/v1/waitTimes
x-api-key: 3jPT5qMimN3kR2kxqd1ez9iF1C68CrBf7zw5ICo4
```

AWS API Gateway behind CloudFront. Without the key: `403 {"message":"Forbidden"}`.
The key is a static app-embedded client identifier, not a user credential.
Returns about 14 KB: one array covering both parks.

```json
{"entityId":"P1NA07","type":"Attraction","parkId":"0/P/P1","status":"OPERATING",
 "responseTimestamp":"2026-10-21T16:00:52.605+0200",
 "singleRider":{"isAvailable":false},"postedWaitMinutes":"10"}
```

| Field | Notes |
|---|---|
| `entityId` | Matches the GraphQL activity `id` |
| `parkId` | `0/P/P1` Disneyland Park, `0/P/P2` Disney Adventure World |
| `status` | Seen: `OPERATING`, `DOWN`, `REFURBISHMENT`. `CLOSED` is expected after hours (not yet observed) |
| `postedWaitMinutes` | Minutes, as a string. `"0"` on walk-throughs and closed rides |
| `singleRider` | `{isAvailable, singleRiderWaitMinutes}`; minutes as a string |

How we store it: the wait is kept only while `OPERATING`. `DOWN` is open but
not operational, so it counts as downtime. `REFURBISHMENT` sets the status
note "Refurbishment", which the closed-notice logic files as maintenance. Rides
the catalog marks `singleRider` get a second `single_rider` line.

On 2026-10-21, 24 of the 73 feed entries had no GraphQL activity in any
market (`en-gb`, `fr-fr`, `en-int`), and `activity(id:)` returns
`NotFoundException` for them. One (P1DA14) was operating with a 15 minute
wait. The app builds its list from the catalog (`filteredActivities`) and looks
waits up in `waitTimesMap` by id, so these never show in it. We drop them too.

## 3. GraphQL

```
POST https://api.disneylandparis.com/query
content-type: application/json
x-application-id: mobile-app
```

No auth. Introspection is off, and a request with no `operationName` returns 500.
The app's query texts are readable in the bundle (29 operations, e.g.
`activities`, `attraction`, `activitySchedules`, `schedules`, `themeParks`).

### 3.1 Ride catalog

```graphql
query attraction($market:String!,$types:[String]){
  activities(market:$market,types:$types){
    id name location{id} subLocation{value}
    ... on Attraction{singleRider height{value}}
  }
}
```

With `{"market":"en-gb","types":["Attraction"]}`: 62 attractions. `location.id`
is the park (`P1`/`P2`), `subLocation.value` the land. `height[0].value` is
"Any Height", "1.20 m" or "81 cm".

Data quirks: Main Street Station is listed twice (P1MA01 and P1MA05, same
name and wait), so we keep one row per name. The Ratatouille name ends in a
zero-width space.

We fetch this once per UTC day per park and cache it in R2 at
`dlp/<park>/meta.json`, together with that day's opening window.

### 3.2 Opening hours

```graphql
query activitySchedules($market:String! $types:[ActivityScheduleStatusInput]! $date:String!){
  activitySchedules(market:$market,date:$date,types:$types){
    id schedules(date:$date,types:$types){startTime endTime date status closed}
  }
}
```

`types: [{type:"ThemePark", status:["OPERATING","EXTRA_MAGIC_HOURS","CLOSED","REFURBISHMENT"]}]`.
One date per field. Each park day has an `OPERATING` slot and usually an
`EXTRA_MAGIC_HOURS` slot before it. Times are Paris wall clock (`"09:00:00"`).

Aliasing works: one request carrying 150 dates as `d20261021: activitySchedules(...)`
fields returned in 1.7 s with 36 KB. Dates past the published horizon return
`[]`; on 2026-10-21 that horizon was 2026-12-30. Past dates also return `[]`,
so a day's hours can't be fetched once it has gone.

`themeParks`-style `activities(types:"ThemePark"){schedules{...}}` with no date
returns today only.

## 4. Time zone

Paris is one hour ahead of the UK parks. `timeZone: "Europe/Paris"` on the park
config (backend) and the catalog entry (frontend) drives:

- the queue sparkline window (`tzOffsetMin` in `src/dlp.ts`),
- clock times on the Queues tab (`parkTime` in `frontend/src/Queues.tsx`),
- the iCal feed's `VTIMEZONE`/`TZID` (`src/ical.ts`).

The queue day is still the UTC date, which is safe for Disneyland Paris: the
earliest Extra Magic Time and the latest close sit well inside one UTC day.

## 5. To verify

- What the feed does after close: `CLOSED` status, or entries dropping out.
- Whether `DOWN` rides recover cleanly in the uptime figures.
