# Merlin Annual Pass entry restrictions — Reference

The dates a Merlin Annual Pass level is refused entry ("exclusion dates" in the
pass T&Cs). Read by `src/restrictions.ts`, served as
`calendar/merlin/restrictions.json`, shown on the calendar for the four Merlin
parks and used by `src/anomalies.ts` as evidence about a date.

Unlike everything else in this repo this is **not a park's feed**: one calendar
covers the whole Merlin estate. So it's polled once and filed under the
pseudo-park key `merlin`, which is not a `ParkConfig` and nothing else keys off.

Everything below was found on the public pass site
(`www.merlinannualpass.co.uk`). No auth, no app decompile.

---

## 1. Source

The restriction-dates page renders a Vue component that calls two Umbraco API
endpoints. Both are plain unauthenticated GETs, no headers required (no bot
protection on this host — a bare `curl` works).

```
https://www.merlinannualpass.co.uk/umbraco/api/EntryRestrictionDates
  /GetPassTypes?passRestrictionIds=<csv>&culture=en-GB
  /GetEntryRestrictionDates?passRestrictionIds=<csv>&useInvertedDates=false&culture=en-GB
```

`passRestrictionIds` is a comma-separated list of pass GUIDs, and it *filters*
the answer: ask about one id and you get that one level's dates and nothing else.

### Pass ids are discovered, not hardcoded

The page declares the live list in its own markup:

```html
<passtype-restrictions-dates
  passes="497a9da9-…,2b1836f9-…,ab93e3ae-…,498cd0c1-…,2f04d5ac-…"
  v-bind:show-headlines="false" v-bind:use-inverted-dates="false">
</passtype-restrictions-dates>
```

`discoverPassIds()` scrapes that attribute, because the levels rotate:
Merlin has since added **Essential**, and **Silver**'s id still names dates while
`GetPassTypes` no longer returns an entry for it at all. `RESTRICTION_PASS_IDS`
in `src/config.ts` is only the fallback for a failed scrape — a stale id there
costs one missing level, not a failed poll.

> The page carries three other GUIDs (a OneTrust domain script, an Application
> Insights key + app id). Matching the `passes="…"` attribute rather than "any
> GUID on the page" is what keeps those out.

## 2. Responses

`GetPassTypes` — name and swatch per id. Used **only** for the colour, so a level
missing from it (Silver, today) still names dates:

```json
[{"name":"Essential Pass","color":"#134791","id":"497a9da9-…"},
 {"name":"Gold Pass","color":"#efd625","id":"2b1836f9-…"}, …]
```

`GetEntryRestrictionDates` — one element per **day** across the published span,
with the levels blocked that day (empty on an ordinary day):

```json
{"filters":["Essential Pass","Gold Pass","Platinum Pass","Silver Pass","Discovery Pass"],
 "startDate":"2025-02-15T00:00:00","endDate":"2027-12-27T00:00:00",
 "entryRestrictionDatesElements":[
   {"key":"20261106","passTypes":["Essential Pass","Gold Pass","Silver Pass","Discovery Pass"]},
   {"key":"20261107","passTypes":[]}, …]}
```

`filters` is the authoritative level list for the ids asked about — it includes
Silver, which `GetPassTypes` omits — so it's what we use as the denominator.

**The span is the point.** As of 2026-09-14 it runs `2025-02-15 → 2027-12-27`:
1,046 days, 73 of them restricted. That is **~15 months further ahead** than the
accesso ticket catalog and further than any park's opening-hours feed.

## 3. What the calendar actually says

Three shapes appear, and they mean different things:

| Shape | Example | Meaning |
|---|---|---|
| Every level blocked | 2025-12-25, 2026-12-25, 2027-12-25 | Christmas Day — the parks are shut |
| Every level **but Platinum** | 2025-11-07/08/09, 2026-11-06/07/08, 2027-11-05/06/07 | The first November weekend: the partner buyout days |
| Essential / Silver / Discovery | school peaks, late-Oct weekends, 2026-12-19/26/27 | An ordinary busy day the lower levels are excluded from |

Gold is blocked on 22 days in the whole published calendar; Platinum on 3.

The second row is the one worth having. **2026-11-06/07/08** are exactly the dates
`src/special-days.ts` identifies at Thorpe from the exchange catalog — John Lewis
Partnership Event, then two Blue Light Card member days. The pass calendar reaches
the same three dates from a completely different direction, knowing nothing about
packages, merchants or allocations. And **2027-11-05/06/07** are already published
with no such package in existence yet.

So `blackoutDates()` draws the line at "every level but one" rather than "every
level": that catches both the closure and the buyout shape, and leaves the
ordinary peak days alone. A `tiers.length >= 3` guard stops the rule degenerating
if the feed ever returns a one- or two-level list.

## 4. Served file

`calendar/merlin/restrictions.json` (~4.7 KB), rewritten wholesale on each poll —
like the hours, there's no delta log, and a failed fetch leaves the last good file
in place:

```json
{"generated_at":"2026-09-14T14:03:43.530Z",
 "tiers":[{"name":"Essential Pass","color":"#134791"}, …, {"name":"Silver Pass"}],
 "span":["2025-02-15","2027-12-27"],
 "days":{"2026-11-06":["Essential Pass","Gold Pass","Silver Pass","Discovery Pass"], …}}
```

Only dates with at least one blocked level are kept; `span` is what tells a reader
"not restricted" from "not published yet". `status/merlin/restrictions.json` holds
the usual last-polled / last-changed, with `last_changed` driven by a hash of the
**forward** dates so it advances when Merlin adds or lifts a date, not when a past
day ages out of the window.

## 5. Cadence

Polled on the hourly hours cron (`0 * * * *`, `pollHours` in `src/index.ts`) —
same kind of source, same rate of change, two more GETs an hour. It lands five
minutes before the daily special-days/anomalies cron, so that job always reads a
fresh file.

## 6. Uses

- **Calendar (the four `merlinPass: true` parks).** A `🚫` line per day, phrased
  by `restrictionSummary()`: "All passes", "All but Platinum", or the list.
  Naming four of five levels fills the cell and buries the point, so a near-total
  block is stated as what still gets in. Restrictions may **create** a calendar
  day, since on a far-out date this is often the only thing known about it.
- **Anomalies.** `status/<park>/anomalies.json` gains `pass_blackouts`: the
  reported dates the estate is shut on. It qualifies a finding ("this unexplained
  date is a blackout") rather than being a new kind of contradiction.

## 7. Not done

No D1 history. The served file is a snapshot, and `last_changed` says only *that*
something moved, not what — so "Merlin added 2027-05-25 as a Gold restriction on
2026-09-20" isn't recoverable. The change-log table would look like
`observation`, keyed `(date, tier)`. Worth it only if the additions turn out to
be interesting in themselves.
