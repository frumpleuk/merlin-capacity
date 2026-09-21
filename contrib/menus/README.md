# Park menus

Photos of menu boards, filed by park, venue and visit date, and transcribed
into `menu.json` files for the site's Food tab.

## Layout

Seven parks, grouped by operator: the Merlin four under `merlin/`, and the three
independents each under their own folder, because each is its own operator.

```
merlin/<park>/              alton-towers, thorpe-park, legoland, chessington-world-of-adventures
paultons/ blackpool/ flamingoland/      the independents, each its own operator

<park>/                     either of the above; the shape below is the same
  <venue>/                  one per eatery the official app lists (the venue syncs)
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
  areas.json                the app's own map labels, for the Food tab's map
```

New photos go loose in the park folder; `scripts/menus/ingest.mjs` files them.
The independents have no photos of ours yet: their venues and menus come from
the parks' own apps and websites (see "Menus from someone else" below).

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

`id`, `name`, `category`, `area`, `lat`, `lon`, `menuUrl`, `serves`,
`diningPlans`, `appPassholderDiscount`, `appMissingSince` and `source` are owned by
`sync-venues.mjs` when `id` is an app id, and are overwritten on each sync. Any
other key (`note`, `display`) is yours and survives. For venues outside the app,
`id` and `category` are `null` and `source` is `"photo GPS (mean)"`. The independents' sources are
`"paultons app bundle"`, `"blackpool app map markers"` and
`"flamingo land app (firestore)"`.

`serves` is the park's own line about what a place sells, which only Flamingo
Land publishes. It reads well but groups badly (some are a paragraph), so it is
shown on the venue and never used as a category.

`area` is the nearest land label on the app's map (within 400m), so it groups
venues but isn't authoritative. Paulton's tags only two of its outlets with an
area, so the rest take the area of the nearest POI that has one (within 150m);
Flamingo Land's venues name their own zone; Blackpool's app has no areas at all,
so its venues have none. `appMissingSince` is stamped when a venue
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
  reason explains why, or when the whole menu is `unpriced` (below).
- `unpriced: true` says the source published the dishes but no prices, so every
  item's price is null and the site shows the dishes without a price column. It
  needs a `source` (a menu of ours comes from photographed boards, which have
  prices on them). Paulton's Tenkites boards and Blackpool's venue pages are
  both like this.
- `addOn: true` marks a price that is an addition to something else rather
  than a thing you buy on its own: "Add Regular Soft Drink £4.00", "Extra
  Bacon", "Upgrade to large fries", "+ 2 Dips". A side you can buy by itself
  (mushy peas, a dip pot, a sauce pot) is an ordinary item. Add-ons are shown
  as "+£4.00" and are left out of a venue's price range.
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

### Menus from the park itself

A park that publishes its own menus gets them imported with an `official`
source, and no photos:

```json
"source": {
  "name": "Paultons Park",
  "official": true,
  "url": "https://menus.tenkites.com/paultonspark/route83diner"
}
```

Three importers, one per park, each cached and fetching one page a second:

| Script | Park | Gets |
|---|---|---|
| `import-tenkites.mjs` | Paulton's | Every dish, its description, its calories and the park's v/vg marks, from the Tenkites boards. No prices: the park leaves every price field empty. |
| `import-bpb-menus.mjs` | Blackpool | The dish lists on each `<venue>-menu` page, and whether a Season Pass gets a discount there. No prices either. |
| `import-flamingoland-menus.mjs` | Flamingo Land | The Coach House food and drinks menus, **with prices**, calories and allergen marks. Drinks are sized items (25ml / Double). |

A re-run writes nothing when the menu hasn't changed; when it has, the new one
lands under today's date beside the old one, which is the history.

### Menus from someone else

Not every menu is ours. `scripts/menus/import-tpj.mjs` reads the menus Theme
Park James publishes, including past ones going back years, and writes them as
ordinary dated menus with a `source` block. He covers six of the seven parks
(all but Blackpool), and for Paulton's and Flamingo Land his are the **only**
prices anywhere, back to 2019:

```json
"source": {
  "name": "Theme Park James",
  "url": "https://www.themeparkjames.co.uk/.../menu/",
  "stated": "November 2023",
  "menu": "Lunch Menu 2023"
}
```

A sourced menu has no photos, so its items cite none, and `approxDate: true`
says the day is a stand-in for a month or a year he gave.

Prices are facts, but collecting them is his work, and his pages carry the
write-up, the photos and the context that this site doesn't. So the credit is
not decoration: every sourced menu names him above its prices and links to his
write-up (`source.venueUrl`, the page his menu tab hangs off), the Food tab
carries a standing credit to his site, and the aim is that anyone who finds a
price here goes and reads him. Don't remove either link, and don't copy his
prose.

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
| `node scripts/menus/sync-venues.mjs [park_key...]` | Creates or refreshes the Merlin parks' venue and water folders from the official apps. Reports renames and venues gone from the app; never deletes. |
| `node scripts/menus/sync-venues-indie.mjs [park_key...] [--poi <file>]` | The same for Paulton's, Blackpool and Flamingo Land, each from its own backend. Paulton's POIs ship inside the APK rather than being served, so pass an unpacked `points_of_interest.json` with `--poi`; without it that park is skipped. Blackpool needs `BPB_EMAIL`/`BPB_PASSWORD` (`.dev.vars`). |
| `node scripts/menus/import-tenkites.mjs` | Paulton's own menus (dishes, calories, no prices). |
| `node scripts/menus/import-bpb-menus.mjs` | Blackpool's own menus and its Season Pass discounts. |
| `node scripts/menus/import-flamingoland-menus.mjs` | Flamingo Land's own menus, with prices. |
| `node scripts/menus/ingest.mjs plan` | Suggests a venue for each loose photo by GPS; writes `contrib/menus/.ingest-plan.json`. |
| `node scripts/menus/ingest.mjs sheets` | Makes labelled contact sheets of the planned photos. |
| `node scripts/menus/ingest.mjs apply` | Moves photos (with sidecars) into `<venue>/<date>/` as planned. |
| `node scripts/menus/optimise.mjs [--force]` | Writes the committed `web/*.jpg` copies (1600px, EXIF stripped) and records their names in `menu.json`. Run after transcribing. |
| `node scripts/menus/validate.mjs` | Checks layout and every `menu.json`. |
| `node scripts/menus/build.mjs` | Compiles everything into `frontend/src/menus.generated.json`. Runs from `npm run build`. |
| `node scripts/menus/publish.mjs [--dry-run]` | Uploads web copies R2 doesn't have yet. Runs from `npm run deploy`, and from CI as the last step of the Cloudflare deploy command. |
| `node scripts/menus/basemap.mjs [park_key...]` | Rebuilds a park's OpenStreetMap basemap (`frontend/public/basemaps/<park>.json`). Only needed when the park changes on the map. |

## Photos

Camera originals stay on the photographer's machine: they are evidence, and
`.gitignore` keeps them (and the Live Photo videos) out of the repo. The small
`web/*.jpg` copies are committed, and `publish.mjs` uploads them to R2 under
`menus/<park>/<venue>/<date>/<name>.jpg`, which the worker serves at
`/menus/...` with a one-year cache. Keys are immutable: a changed board is a
new photo on a new date.

Agents: use the `/menus-add-photos` and `/menus-transcribe` skills in
`.claude/skills/`, which wrap these steps.
