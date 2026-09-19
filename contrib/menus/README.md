# Park menus

Photos of menu boards, filed by park, venue and visit date, and transcribed
into `menu.json` files for the site's Food tab.

## Layout

```
merlin/<park>/
  <venue>/                  one per eatery the official app lists (sync-venues.mjs)
    poi.json                where it is and what the app calls it
    <YYYY-MM-DD>/           one per visit, named for the photos' capture date
      IMG_1234.HEIC         camera originals + Live Photo sidecars (git-ignored)
      menu.json             the transcription of this visit's photos
      web/loaded-spuds.jpg  committed 1600px copies, served from R2
  water/<point>/            water refill points, same shape as a venue
  _events/<year>-<event>/   temporary food for one event (Cargo Global Eats, Scarefest...)
    event.json
    <YYYY-MM-DD>/           photos of the event as a whole (signage, maps)
    <vendor>/               same shape as a venue
  _<name>/                  not a venue (e.g. _park-wide-offers); no poi.json needed
```

Park folders: `alton-towers`, `thorpe-park`, `legoland`,
`chessington-world-of-adventures`. New photos go loose in the park folder;
`scripts/menus/ingest.mjs` files them.

Venue folder names are the slug of the app's name and never change once
created, even if the app renames the venue (the new name goes in `poi.json`).
A venue that isn't in the app (pop-up trailer, food truck) gets a folder named
for what it is, with a `poi.json` located from the photos' GPS.

## poi.json

```json
{
  "id": 4288,
  "name": "Towers Hot Dogs and Donuts",
  "category": "Food & Drink > Snacks",
  "lat": 52.990171,
  "lon": -1.892122,
  "source": "attractions.io app bundle",
  "note": "Signed as Tasty Treats of Towers Street"
}
```

`id`, `name`, `category`, `area`, `lat`, `lon`, `menuUrl`, `diningPlans`,
`appPassholderDiscount`, `appMissingSince` and `source` are owned by
`sync-venues.mjs` when `id` is an app id, and are overwritten on each sync. Any
other key (`note`, `display`) is yours and survives. For venues outside the app,
`id` and `category` are `null` and `source` is `"photo GPS (mean)"`.

`area` is the nearest land label on the app's map (within 400m), so it groups
venues but isn't authoritative. `appMissingSince` is stamped when a venue
disappears from the app — the site then files it under what used to be there.

**Copyright:** the app's `Summary` text is the park's own marketing copy. Read
facts out of it (dining plan, passholder discount) but never store or publish
the prose. Names, locations, areas and categories are facts and fine to keep.

## event.json

```json
{
  "name": "Cargo Global Eats",
  "area": "Front Lawns",
  "start": null,
  "end": "2026-08-31",
  "discount": "20% off for Gold and Platinum Merlin Annual Pass holders from 5pm",
  "sources": ["https://..."]
}
```

`start`/`end` are ISO dates or `null` when unknown. Cite where dates came from.

## menu.json

One per dated folder: what the boards said on that day. Prices are **integer
pence** (`£8.75` is `875`).

```json
{
  "date": "2026-08-26",
  "sections": [
    {
      "name": "Loaded Spuds",
      "note": "Oven-baked British potatoes with crispy skins",
      "items": [
        { "name": "Smoky Pulled Pork", "description": "...", "price": 1250, "photo": "IMG_3425.HEIC" },
        {
          "name": "Popcorn",
          "sizes": [
            { "label": "Small", "price": 625 },
            { "label": "Large", "price": 925 }
          ],
          "photo": "IMG_3427.HEIC"
        },
        { "name": "Hot Chocolate", "price": null, "unclear": "price hidden by glare", "photo": "IMG_3375.HEIC" }
      ]
    }
  ],
  "passDiscount": { "offered": true, "percent": 20, "applies": "food & drink, 5pm-7pm", "photo": "IMG_3425.HEIC" },
  "offers": [{ "text": "15 donuts for the price of 5 for passholders", "photo": "IMG_3377.HEIC" }],
  "skipped": [{ "photo": "IMG_3378.HEIC", "reason": "shop sign, no menu" }]
}
```

- `date` must equal the folder name.
- Each item has exactly one of `price` (pence) or `sizes` (each with a
  `label` and a price in pence). A price is `null` only when an `unclear`
  reason explains why.
- Optional per item: `description`, `kcal` (integer, as printed), `tags` from
  `v`, `vg`, `gf`, `df`, `alcohol`, `kids`, and `unclear` for anything
  uncertain.
- `photo` names the camera original the item was read from. Every photo in the
  folder must be used by an item or offer, or listed in `skipped` with a reason.
- A size may carry its own `kcal` when the board prints one per size.
- Photos listed in `skipped` get no web copy and no `photos` entry — they stay
on disk as evidence. `photos` is written by `optimise.mjs`, not by hand: one
  `{ file, name, caption }` per photo, where `name` is the committed
  `web/<name>.jpg`. Names are derived from the sections citing the photo and
  then frozen, because they are the R2 keys the site links to. Editing a
  `caption` is fine; renaming means the old URL stops working.
- Copy text as printed, fixing only capitalisation. Don't invent descriptions
  or fill in prices from elsewhere.

### Merlin Annual Pass discount

Whether a pass gets money off is one of the most useful things on the page, so
it is a field rather than prose. `passDiscount` goes in `menu.json` when a
photo shows it (the blue "20% off Food & Drink" roundel, a passholder sign, or
wording that rules it out), and in `poi.json` when we know it some other way:

```json
"passDiscount": {
  "offered": true,
  "percent": 20,
  "upTo": true,
  "applies": "food & drink, 5pm-7pm",
  "photo": "IMG_3425.HEIC",
  "source": "board photo"
}
```

`offered: false` records a place that refuses the pass (Eastern Express).
`percent` is `null` when a discount is offered but the rate isn't stated.
`upTo: true` when the board says "up to 20% off" rather than a flat rate — the
usual Alton roundel does, so don't promise more than the sign does.
`source` is `"board photo"` (the default in `menu.json`) or `"user report"`.
A venue-level `poi.json` entry is the fallback the site uses when that date's
photos show nothing either way.

## Scripts

Need Node 24+, `exiftool`, and (for contact sheets) macOS `sips` and
ImageMagick.

| Command | Does |
|---|---|
| `node scripts/menus/sync-venues.mjs [park_key...]` | Creates or refreshes venue and water folders from the official apps. Reports renames and venues gone from the app; never deletes. |
| `node scripts/menus/ingest.mjs plan` | Suggests a venue for each loose photo by GPS; writes `contrib/menus/.ingest-plan.json`. |
| `node scripts/menus/ingest.mjs sheets` | Makes labelled contact sheets of the planned photos. |
| `node scripts/menus/ingest.mjs apply` | Moves photos (with sidecars) into `<venue>/<date>/` as planned. |
| `node scripts/menus/optimise.mjs [--force]` | Writes the committed `web/*.jpg` copies (1600px, EXIF stripped) and records their names in `menu.json`. Run after transcribing. |
| `node scripts/menus/validate.mjs` | Checks layout and every `menu.json`. |
| `node scripts/menus/build.mjs` | Compiles everything into `frontend/src/menus.generated.json`. Runs from `npm run build`. |
| `node scripts/menus/publish.mjs [--dry-run]` | Uploads web copies R2 doesn't have yet. Runs from `npm run deploy`. |

## Photos

Camera originals stay on the photographer's machine: they are evidence, and
`.gitignore` keeps them (and the Live Photo videos) out of the repo. The small
`web/*.jpg` copies are committed, and `publish.mjs` uploads them to R2 under
`menus/<park>/<venue>/<date>/<name>.jpg`, which the worker serves at
`/menus/...` with a one-year cache. Keys are immutable: a changed board is a
new photo on a new date.

Agents: use the `/menus-add-photos` and `/menus-transcribe` skills in
`.claude/skills/`, which wrap these steps.
