# Flamingo Land Calendar (What's-On) — Reference

How this repo builds a **calendar** for Flamingo Land Resort. Flamingo Land was
added first as a **queue-only** park (live ride waits from Firebase Firestore —
see `docs/flamingoland-api.md`). This doc covers the *second* stream: a
day-by-day **What's On** calendar, so the park gains a Calendar tab (like
Blackpool, `docs/blackpool-api.md`).

Everything below was found by exploring the public marketing site
(`www.flamingoland.co.uk`) — no app decompile needed.

---

## 1. Why "What's On", not opening hours

The task was: find an **opening-times calendar**, failing that an **opening-days
calendar**, failing that **special events**. Flamingo Land publishes none of the
first two in any structured, forward-looking form:

- **Opening times.** The "Park Opening Times" panel on
  `/plan-your-visit/whats-on-and-opening-times/` (the canonical `/plan-your-visit/
  opening-times/` 301-redirects here) is a *single, manually-edited WordPress text
  block* — "…today our Theme Park will close at 5:00 pm…". It carries **today only**
  and no future dates. There is no per-day hours feed.
- **Opening days.** Nothing structured. (Editorially the park runs daily from
  ~late-March to early-November; that isn't published as data.)
- **The app / Firestore.** The guest app's `flamingo-land-app` Firestore project
  exposes only `rides_data` (probed a wide list of plausible collection names —
  `opening_times`, `calendar`, `park_hours`, … — all empty). No opening calendar
  there either.

So we fall to the **third** option — special events — which *is* published, richly
and with dates, via **The Events Calendar** (Modern Tribe) WordPress plugin. The
result is a "What's On" calendar: every open day shows its evening **headline act**
plus the full daily lineup (parades, kids' shows, tribute acts, seasonal specials
like Flamingo Fest). A day having events is itself the open-day signal.

---

## 2. Source: The Events Calendar iCal feed

The site runs **The Events Calendar / Events Calendar Pro** (confirmed by enqueued
`the-events-calendar` / `events-calendar-pro` assets and a `tribe_events` sitemap
with ~590 event URLs). Its public data surfaces were tested:

| Surface | Result |
|---|---|
| REST API (`/wp-json/tribe/events/v1/events`, `?rest_route=`) | **403 `forbidden_access`** — a server WAF blocks `/wp-json` outright. Unusable. |
| Category/taxonomy archives (`…/category/main-act/`) | **404** — the events archive base is remapped to `/holiday-resort/entertainment-guide/`, breaking taxonomy archive routes. |
| Category-filtered iCal (`…/category/<cat>/?ical=1`) | Redirects to the archive and returns the **unfiltered** feed — the category filter is dropped. |
| **Plain iCal feed** (`…/?ical=1`) | ✅ **200 `text/calendar`.** The one that works. |

### Endpoint

```
GET https://www.flamingoland.co.uk/holiday-resort/entertainment-guide/list/?tribe-bar-date=<YYYY-MM-DD>&ical=1
```

- A plain browser `User-Agent` is enough (the shared `USER_AGENT`); no
  Cloudflare/WAF header dance like Blackpool's hosts.
- `text/calendar`, RFC 5545. Times are **local wall-clock** —
  `DTSTART;TZID=Europe/London:20260725T160000` — so the `HHMMSS` digits are used
  as-is (no timezone conversion), matching how BPB/Paulton's hours are formatted.

### Pagination — the one wrinkle

Tribe caps the iCal export at **30 VEVENTs per request** and there is no count
override. Flamingo Land runs a **dense** daily schedule (~9–13 events/day:
Welcome Parade, Pirates of Zanzibar, Peter Rabbit, Tiny Tots, bingo, a Main Act,
karaoke…), so 30 events ≈ **~2–3 days**.

`tribe-bar-date=<date>` shifts the 30-event window to start at that date. So we
**walk forward**: fetch from today, note the furthest `DTSTART` date returned,
re-request starting at that date, and repeat — deduping by `UID`. We stop once the
window reaches `windowDays` ahead, the walk stops advancing, or `maxPages` is hit
(a subrequest-budget backstop). Because ~1 day of overlap is re-fetched each page
to avoid clipping the boundary day's later events, ~12–14 pages cover ~2 weeks —
a deliberately **rolling short window**, refreshed hourly, rather than the whole
season. Distant planning isn't served, but the schedule is templated day-to-day
anyway, and the window rolls forward as dates approach (past days freeze in the
per-month files, keeping their final lineup).

---

## 3. VEVENT shape (fields we use)

```
BEGIN:VEVENT
DTSTART;TZID=Europe/London:20260725T160000
DTEND;TZID=Europe/London:20260725T230000
UID:10162007-1784995200-1785020400@www.flamingoland.co.uk
SUMMARY:Flamingo Fest presents Pink Boots & Cowboy Roots!
CATEGORIES:Main Act,Evening Entertainment
URL:https://www.flamingoland.co.uk/event/flamingo-fest-presents-pink-boots-cowboy-roots/
END:VEVENT
```

| Field | Use |
|---|---|
| `UID` | Dedup key across paginated pages. |
| `DTSTART` / `DTEND` | Day (ISO) + a display `time` ("4pm – 11pm", or a single "6:15pm" when start == end, or omitted for all-day `VALUE=DATE`). |
| `SUMMARY` | Event name. iCal-escaped (`\,` `\;` `\\` `\n`) — unescape. |
| `CATEGORIES` | Comma list. Drives grouping + **headline** selection. Seen: `Daytime Shows`, `Evening Entertainment`, `Kids Entertainment`, `Main Act`, `Things To Do`, `Special Events`. |

### Headline (the day's badge)

Category filtering is impossible server-side, so it's done client-side. Per day
we pick one **headline** — the event badged on the calendar cell — in priority
order: **Main Act** (the evening tribute/concert headliner, what varies day to day
and what guests plan around) → **Special Events** / **Things To Do** (seasonal
one-offs) → otherwise none (a plain daily-shows day still renders, flagged as
"live entertainment"). The full day's lineup is kept in `events[]` for the detail
view.

---

## 4. Integration (this repo)

Modelled as an `OpeningHoursConfig` of `kind: "flamingoland"` (`src/config.ts`),
so it rides the existing **hours** stream (the every-60-min branch of the tickets
cron, `runHoursPoll`) — no new cron. `src/hours.ts` `fetchFlamingolandHours`
paginates the iCal feed, parses/dedupes/filters, and maps each day onto the shared
`HoursSnapshot`:

- The shared `HoursDay` gained an optional **`events: DayEvent[]`** (`{name, time?,
  category?}`) — the day's lineup. `locations` is left empty (there are no
  opening-hours rows to show), and the day's `event` badge is the headline.
- Everything downstream is reused: `writeHoursMonths` writes per-month files
  (merged, so past days freeze), `updateParkIndex` bounds the calendar nav, and
  `hashHours` (extended to fold in `events`) drives `last_changed`.

Frontend: the park's catalog entry drops `queueOnly` (keeping `liveClosed`,
`products: []`) so the **Calendar tab shows** alongside Queues — the same shape as
Blackpool. `ParkCalendar` renders `events` in both the compact cell (headline +
event count) and the day detail (grouped lineup with times).

### Caveats

- **Rolling ~2-week window only** (the 30-per-request iCal cap × dense schedule).
  Not a full-season calendar.
- **Undocumented / private.** The iCal feed is a plugin default that the park
  could disable, reroute, or rate-limit; the archive remap already broke the REST
  API and taxonomy archives. The feed URL and 30-event cap can change without
  notice.
- **All events, not just "special".** The feed conflates daily filler (bingo,
  karaoke) with genuine specials; only the headline is surfaced prominently.
