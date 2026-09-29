---
name: menus-add-photos
description: File new theme-park menu photos into contrib/menus/merlin/<park>/<venue>/<date>/. Use when the user has dropped new menu photos into a park folder, or asks to sort, file or organise menu photos.
---

# Add menu photos

Layout and file formats: `contrib/menus/README.md`. Read it first.

The user drops photos (iPhone HEIC with Live Photo MP4s) loose into
`contrib/menus/merlin/<park>/`. Your job is to get each photo into the right
`<venue>/<YYYY-MM-DD>/` folder, checking with the user wherever the evidence is
thin. Do not transcribe here; that is `/menus-transcribe`.

## Steps

1. **Refresh venues** so new app eateries exist as folders:
   `node scripts/menus/sync-venues.mjs`. Relay any `~` renames or `?`
   vanished venues to the user.

2. **Plan**: `node scripts/menus/ingest.mjs plan`. This prints each loose photo
   with its capture time and the three nearest venues by GPS, and writes
   `contrib/menus/.ingest-plan.json` with the nearest venue pre-filled.

3. **Look at every photo**: `node scripts/menus/ingest.mjs sheets`, then Read
   each contact sheet it prints. Decide each photo's venue from what it shows
   (venue name on the board or signage, branding) together with GPS and
   time order. Photos taken seconds apart at the same spot are usually the
   same venue.

4. **Correct the plan**: edit `venue` in `.ingest-plan.json` (path relative to
   the park folder). Rules:
   - GPS is often 20-40m out, worse indoors. A board that names its venue
     beats the nearest pin.
   - Many stalls are not in the app: pop-up trailers, food trucks, event
     vendors. Give them a new folder named for what the signage says
     (`chocolate-and-waffles`), not the nearest app venue.
   - One venue can carry several sub-brand boards sharing one till (e.g.
     Loaded Spuds boards at Mutiny Bay Hot Dogs). File them under the venue;
     the transcription gives each board its own section.
   - A unit with its own hatch and board is its own venue, even when the app
     doesn't list it: the Fountain Square Pizza, Loaded Fries and Nachos &
     Treats trailers each have a folder (with `displayArea` "Fountain
     Square"). Don't fold them into a nearby app venue.
   - Food for a temporary event goes under
     `_events/<year>-<event-slug>/<vendor>/`. Create `event.json` (name, area,
     start, end, sources); search the web for official dates and cite them,
     leaving `null` where no source gives a date.
   - Park-wide posters (passholder offers) go in `_park-wide-offers`.
   - Set `venue` to `null` for anything that isn't a menu and that the user
     may not want kept, and mention it.

5. **Ask before moving** when the venue isn't clear from the photo itself.
   Show the user the proposed grouping as a short list, flagging each
   uncertain call with its evidence (what the board says, GPS distance to
   the nearest candidates, capture time). The user was there and knows
   the answers; don't guess names for unnamed stalls.

6. **Apply**: `node scripts/menus/ingest.mjs apply`. It moves each photo and
   its sidecars into `<venue>/<capture date>/` and creates `poi.json` for new
   venues from photo GPS. Fill in `name` (as signed) in each new
   `poi.json`. A `note` is shown to guests on the site, so add one only when
   it helps them find or recognise the place ("Pop-up trailer near the Sky
   Ride", "Signed as Tasty Treats of Towers Street"); never how it was filed,
   whether the app lists it, or when it was seen.

7. **Validate**: `node scripts/menus/validate.mjs`. Fix every ERROR. Warnings
   about missing `menu.json` are expected until transcription.

8. Report to the user what went where (count per venue, new venues, new
   events), then offer `/menus-transcribe` for the new dated folders.
