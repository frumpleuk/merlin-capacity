---
name: menus-transcribe
description: Transcribe filed theme-park menu photos into menu.json (items, prices in pence, sizes, kcal). Use when dated menu folders under contrib/menus/merlin have photos but no menu.json, or the user asks to OCR, read or transcribe menus.
---

# Transcribe menus

Schema and rules: the `menu.json` section of `contrib/menus/README.md`. Read
it first. Prices are integer pence. Every photo in the folder must be used by
an item or offer, or listed in `skipped`.

## Find the work

`node scripts/menus/validate.mjs | grep 'no menu.json'` lists dated folders
still to do. If the user named venues or a date, do only those.

## Per dated folder

1. Convert each photo to a readable JPEG in your scratchpad (not in the repo):
   `sips -s format jpeg -Z 3000 <photo> --out <scratch>/<name>.jpg`.
   Many photos are sideways; rotate with
   `magick <in> -rotate 90 <out>` (or -90/180) until text reads upright.
2. Read each JPEG. If text is small, crop the region and read the crop:
   `magick <in> -crop <w>x<h>+<x>+<y> +repage <out>`. Read prices from the
   crop, never from a downscaled overview.
3. Write `menu.json` in the dated folder:
   - One section per board or board heading, named as printed. Sub-brand
     boards at one venue (e.g. Loaded Spuds at Mutiny Bay Hot Dogs) are
     their own sections.
   - Item names and descriptions as printed (fix only ALL-CAPS). Keep
     dietary marks as `tags` (`v`, `vg`, `gf`, `df`); `kcal` only where
     printed.
   - Size ladders (Regular/Large, 1 scoop/2 scoops, 3 piece/5 piece) are
     `sizes`, not separate items. Meal vs item-only prices are sizes too.
   - A price that only makes sense on top of something else is an add-on:
     set `addOn: true` ("Add Regular Soft Drink", "Extra Bacon", "Upgrade to
     large fries", "+ 2 Dips"). A side you can buy on its own is an ordinary
     item, even at 50p.
   - The Merlin Annual Pass discount is its own `passDiscount` field, not an
     offer: look on every photo for the blue "20% off Food & Drink" roundel,
     a passholder sign, or wording that rules the pass out, and record
     `offered`, `percent`, `upTo` (true when the sign says "up to 20%"),
     `applies` (times/conditions) and the `photo`. Say
     `offered: false` when a board states the pass isn't accepted. Leave the
     field out when no photo shows either.
   - Other discounts and deals (meal deals with no fixed item, "15 donuts for
     the price of 5") go in `offers`.
   - Allergen charts, shop signs, photos of the queue: `skipped` with a
     reason.
   - Anything you cannot read with confidence: `price: null` (or the best
     reading) plus `unclear` saying why. Never fill a gap from another
     venue, another date, or general knowledge.
   - A photo of an ordering tablet or app shows only some items per screen;
     transcribe what is visible and note in the section `note` that the
     list may be partial.
4. `node scripts/menus/validate.mjs` and fix every ERROR for that folder.
5. `node scripts/menus/optimise.mjs` once the folders are transcribed. It
   writes the committed `web/*.jpg` copies and records their names and
   captions in `menu.json`. Check the generated names read sensibly
   (they come from your section headings); fix a poor one by editing the
   section name and re-running, not by renaming the file.

## Many folders

For more than a handful of folders, give each venue to a subagent with
this skill's instructions, the README path and the folder path, and have it
return the list of `unclear` items. Check a sample of their prices against
the photos yourself before reporting.

## Report

List the folders done, then every `unclear` item (venue, item, photo, why)
so the user can check them against their memory or re-photograph.
