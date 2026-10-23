# OpenWeather One Call 4.0

Weather for every park, in `src/weather.ts`. Docs:
https://openweathermap.org/api/one-call-4

## Access

- Key: Worker secret `OPENWEATHER_KEY` (`.dev.vars` locally). Absent, the
  weather cron and `/weather` do nothing.
- Needs the "One Call by Call" subscription. 1,000 calls a day free, then
  billed per call. The account's daily cap is set to 1,000 under Billing plans
  (the default is 2,000).
- A 401 saying "requires a separate subscription" also comes back while a new
  key is still activating, along with "Invalid API key" from the 2.5 endpoints.

## Endpoints used

Base `https://api.openweathermap.org/data/4.0/onecall/`, all with `lat`, `lon`,
`units=metric`, `start` (unix seconds) and `appid`.

| Endpoint | Records | Used for |
|---|---|---|
| `timeline/1h` | 20 hours from `start`; history and 48 h ahead | Queues tab, one park day |
| `timeline/1day` | 10 days from `start`; history and up to 1.5 years ahead | Calendar |

Each record has `dt`, `temp` (an object with `min`/`max` on daily records),
`feels_like`, `pop`, `rain`/`snow`, `wind_speed`, `wind_gust`, `clouds`, `uvi`
and `weather[0]` (`id`, `icon`, `description`). Pages followed through
`next`/`prev` cost a call each; we never follow them.

Checked against live responses on 2026-10-23:

- `start` is honoured: `1h` from 06:00Z returns 06:00Z to 01:00Z, history and
  forecast in one run.
- Hourly `rain`/`snow` are `{ "1h": mm }`. `pop` is absent on past hours.
- Daily `dt` is the local date written as UTC midnight, in every zone (Tokyo's
  23 October is `2026-10-23T00:00Z`, with sunrise at 06:04 local that day).
  So the record's date is the UTC date of `dt`, and `start` is that date's
  UTC midnight. Daily `rain` is a plain number, the day's total in mm.
- Daily records carry no `wind_gust`. The calendar's `gust` is the highest
  hourly gust from that day's hourly file (07:00 to 02:00), so it exists for
  today, tomorrow and every past day with a queue file.
- A 4.0 401 ("requires a separate subscription") persisted for a while after
  subscribing, after the key already worked on 2.5.

Coordinates are `ParkConfig.weather`: the mean of each park's mapped food
venues (`frontend/public/menu-data`), to 3 dp.

## Schedule and budget

Cron `2 * * * *`, its own invocation:

- every hour, `timeline/1h` from 07:00 park time for every park's current park
  day (23 calls). 20 hours from 07:00 reach 02:00, before the 04:00 rollover;
- every 6 hours (UTC 00, 06, 12, 18), `timeline/1day` from yesterday for every
  park with a Calendar tab (23 calls; every park has one), and `timeline/1h`
  for tomorrow's park day (23 calls), whose highest gust is the calendar's;
- at 03:00 UTC, backfill with what the rest of the day can spare: calendar
  days from the park's first queue day, then queue days that have a queue
  file but no weather, newest first, a park at a time in turn.

Every call is reserved first against a per-UTC-day count in R2
(`weather/budget.json`, limit 900). A 429 marks the day spent. `/weather?key=`
runs the hourly job now; `&days=1` the calendar's ten days; `&backfill=1` up to `&limit=` (default 150) backfill calls, leaving the rest of the day's scheduled calls alone. All
count against the same budget, and `/poll` does not touch weather.

## Files

- `queues/<park>/weather/<date>.json`: `{ date, generated_at, hours: [...] }`.
  `t` is minutes since `${date}T00:00:00Z`, as in the queue day files.
  `fc: 1` marks an hour still to come at the time of writing; the last write
  of a day is after its last hour, so a finished day has none.
- `calendar/<park>/weather/<YYYY-MM>.json`: `{ days: { "YYYY-MM-DD": {...} } }`,
  merged so past days keep their last write. `fc: 1` marks a date that was
  today or later when written; the next 6-hourly run rewrites yesterday as
  recorded.
