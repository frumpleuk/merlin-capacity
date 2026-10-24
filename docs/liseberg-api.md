# Liseberg

The Liseberg app (`se.liseberg.liseberg`, native Android) reads a public JSON
API on the park's website: `https://www.liseberg.se/en/api/app/`
(`/sv/api/app/` for Swedish). There's no key; the base is in the app's dex and
in ThemeParks/parksapi (`src/parks/liseberg`, as `LISEBERG_BASEURL`).

## Queues

`GET attractions/` returns an array of every ride with these fields:
- `id`, `title` and `type: "attraction"`;
- `coordinates {latitude, longitude}`;
- `heightLimitation` as text: "At least 130 cm or 120 cm if accompanied by
  adult. At least 10 or 8 years old if accompanied by adult";
- `state {isOpen, minWaitTime, maxWaitTime, status}`.

The waits are minutes, -1 when none is posted. `status` reads "Today: 11:00 -
20:00" when the ride has hours today, and other text otherwise ("Opening the
24th of October").

src/liseberg.ts reads `state` like this:
- A ride is running when `isOpen` is true.
- Its wait is `maxWaitTime`.
- Its own "Today:" window is its schedule. A ride that isn't running inside its
  window is down; outside the window it's shut.

The rides carry no grouping.

## Hours

`GET calendar/<YYYY-MM-DD>/<days>` returns one entry a day:
- `dateRaw`;
- `closed`;
- `openingHoursDetailed {full, from, to}`, in whole hours ("11", "23").

One request for 120 days works.

Other hosts in the app, not used here:
- `webapi.liseberg.se/api/v1/calendar/` and `/guest/`;
- `apim.liseberg.se` (period pass, guest profile);
- `virtualqueue.liseberg.se`;
- `auth.liseberg.se`.
