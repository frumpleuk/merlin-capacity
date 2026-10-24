# Efteling

The Efteling app (`nl.efteling.android`, React Native) reads `api.efteling.com/app/`.
The app carries an API key, stored scrambled in its native code (`ij0/b.smali`
decodes it: base64, reverse, bitwise-not per byte, then +0x11 mod 256). The
recovered key is a Worker secret, `APP_KEY_EFTELING`, never in the repo. The
same key is in parksapi (`src/parks/efteling`).

Every request sends the app's headers:

```
x-api-key: <key>
x-api-version: 9
x-app-version: v5.18.0
x-app-name: Efteling
x-app-id: nl.efteling.android
x-app-platform: Android
x-app-language: en
x-app-timezone: Europe/Amsterdam
user-agent: okhttp/5.1.0
```

## Queues

`GET app/wis` returns `{OpeningHours, AttractionInfo[]}`:
- `AttractionInfo[]`: `{Id, Name, Type, Empire, State, WaitingTime?}`. `Type`
  is Dutch (`Attracties` for rides, `Eten en Drinken`, `Souvenirwinkels`,
  `Shows en Entertainment`, ...). `State` is Dutch too:
  - `open` = running;
  - `tijdelijkbuitenbedrijf`, `storing`, `wachtrijvol` = open but stopped;
  - anything else, and the empty state overnight, = closed.
  - `WaitingTime` (minutes) is present only when there's a wait.
- `OpeningHours.Resort {HourFrom, HourTo}` is today's park window (ISO with
  offset).

Single rider is a separate `AttractionInfo` row; the POI feed says which main
ride it belongs to (`alternatetype: "singlerider"`, `alternateid` = the SR
row's id).

## Ride metadata

`GET app/poi` returns `hits.hit[].fields`:
- `id`, `name`, `category` (`attraction`, `restaurant`, `fairytale`, `show`, ...);
- `empire`, the themed land (grouping);
- `properties[]`, including `minimum<NNN>` heights in cm;
- `alternatetype` / `alternateid` for single-rider rows;
- `latlon`.

src/efteling.ts reads `poi` once a park day (cached in R2) and `wis` every poll.
Ride ids are words, so each gets a stable FNV-1a number.

## Hours

The public website, no key:
`GET https://www.efteling.com/service/cached/getpoiinfo/en/<year>/<month>`
with `X-Requested-With: XMLHttpRequest`, a referer of
`https://www.efteling.com/en/park/opening-hours?app=true`, and the cookie
`website#lang=en`. It returns `{OpeningHours:[{Date, OpeningHours:[{Open,Close}]}]}`,
local HH:MM, one call a month. A past month returns 400. The response also
carries a crowd forecast (`Crowdedness`), not used.
