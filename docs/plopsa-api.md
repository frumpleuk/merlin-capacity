# Plopsaland De Panne

Plopsa replaced its Attractions.io app (last bundle 2024-10) with a React
Native app, `com.plopsa.plopsalandresort`, in 2025. The app reads an Azure API
Management middleware that needs no key or token. ThemeParks/parksapi
(`src/parks/plopsa`) reads the same API.

## Queues

Host: `https://apim-stp-gwc-prd-infra.azure-api.net/app-middleware`. The park
slug is `plopsaland-de-panne` (Plopsaland Deutschland is `plopsaland-deutschland`).

- `GET /api/attractions/waiting-times?language=en&park=<slug>` returns
  `{"<rideId>": minutes}`. 0 is the default for every ride overnight and for
  closed rides, so only a positive number shows a ride running.
- `GET /api/points-of-interest?language=en|nl&park=<slug>` returns
  `items[].contains[]`. Rides have `type: "attraction"` and `plopsa_id`, the
  waiting-times key. Other fields:
  - `title`;
  - `experience[]` tags (Thrills, Family, Children, Indoor, Water, Highlight);
  - `height_specs` in cm (`min_height_supervised` with an adult, `min_height`
    alone);
  - `schedule_info.temporarily_closed`, the only sign a ride is down.

  New rides appear in the Dutch feed first, so both are read. Positions are map
  pixels, not coordinates.
- `GET /api/park-opening-hours?language=en&park=<slug>&openOn=YYYY-MM-DD`
  returns `{timeslots:[{type:"open",start_time,end_time}]}` in local HH:MM. It
  returns a 500 without `openOn`.

src/plopsa.ts makes these reads:
- **Waits:** every poll.
- **POIs:** every 5 minutes.
- **Today's window:** once per park day.

A cached copy stands in when a read fails. A ride already flagged temporarily
closed at the first read after opening is shut for the day (water rides out of
season). One flagged later is down. A positive wait overrides the flag.

## Hours

`GET https://www.plopsa.com/en/plopsaland-belgium/api/opening-hours-calendar?start=YYYY-MM-DD&end=YYYY-MM-DD`
returns `{schedule:{"YYYY-MM":{"YYYY-MM-DD":day}}}`. Each day has:
- `closed`, `sold_out` and price fields;
- `labels[].title`, the day's events and the odd longer note ("Due to the
  Plopsa Run, adjusted opening hours apply...");
- `slots[{type:"open",start_time,end_time}]` with ISO times and offsets.

A sold-out day lists no slots. One request covers six months.
