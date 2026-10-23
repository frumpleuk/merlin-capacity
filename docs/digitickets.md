# DigiTickets stores (Xtreme Scream Park, Tulleys)

DigiTickets runs ticket shops for smaller UK attractions at
`<name>.digitickets.co.uk`. Two of our parks sell through it:

| Park | Store | Branch | Category (`catID`) | Event page |
|---|---|---|---|---|
| Xtreme Scream Park | `twinlakes.digitickets.co.uk` | 2340 (the store also sells Twinlakes Park, 2298) | 34521 | `/event-tickets/34254` |
| Tulleys Shocktober Fest | `tulleyshalloween.digitickets.co.uk` | single venue | 73365 | `/event-tickets/73067` |

## The availability calendar

The store's date picker reads
`GET /availability?catID=<cat>&return=json&year=<YYYY>&month=<M>`, with
`X-Requested-With: XMLHttpRequest`. It returns `events[]`, one per bookable date:

- `date` (`YYYY-MM-DD`), `hasAvailability`, `availabilityPhrase` and
  `availabilityClass` for the day, `price` (from, as text).
- `sessions[]`: `time` and `endTime` (`HH:MM`), plus each session's own
  `availabilityPhrase` / `className`.

The bands seen so far, best to worst: "Tickets available" (`high-spaces`),
"Limited availability" (`limited-spaces`), "Low availability" (`low-spaces`),
"Very low availability" (`very-low-spaces`), "Sold out" (`no-spaces`, or no
class with `hasHyperlink: false`). No numbers: the store never exposes
capacity or tickets sold.

The shapes differ by park:

- **Xtreme Scream Park:** one session a night, 18:30 to 23:00, with the band on
  the day and the session.
- **Tulleys:** timed arrival slots every 15 minutes, 16:30 to 19:30. Each slot
  has its own band, the day carries none, and `time` equals `endTime`, so slots
  give arrival times, not opening hours. Tulleys' hours come from its own dates
  page instead (`tulleys` in src/hours.ts).

## The session it needs

Without a session holding a basket, `/availability` 302s to `/tickets`. The
store's own flow, which `digiticketsSession` in src/hours.ts walks:

1. `GET /tickets?branches.branchID=<branch>` puts the venue in the session.
   Without it, adding to the basket redirects to the `/branches` picker.
2. `GET /category/<cat>` 302s to the event page, which carries the ticket form:
   a `csrf-token` and `tickets[<ticketId>][qty]` inputs.
3. `POST /cart/add?catID=<cat>&date=` with the token and one ticket's quantity
   set to 1. A 302 to `/availability?catID=<cat>` means it took.
4. `GET` the availability JSON, per month.

Cookies are carried by hand (`redirect: "manual"`, `getSetCookie()`). Nothing
is bought or held: the basket is abandoned with the session.
