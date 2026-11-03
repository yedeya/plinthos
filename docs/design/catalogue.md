# Public catalogue design

The visitor's side: a static, read-only showcase of one collection, opened from a shared link, usually on a phone. It is served from the snapshot and never touches the database (`AGENTS.md` §1). It reuses the admin's tokens (`docs/design/ui.md`) and its brick-red accent, with more room for photos. Focus is drawn in the admin's `--focus` blue, never the accent, so the red never shows as an outline. Values, asking prices, split views and the parts download appear only when the owner's settings show them (#211, below).

## Principles

- **Photos first.** The owner's own photos show the real condition, so they are large and swipeable, with the stock image beside them.
- **Fast on a phone over a poor connection.** Static HTML and one small script. Thumbnails are 320 px and lazy. Full sizes load only on the detail page.
- **Works without the script.** The grid is in the HTML, sorted by set number, every item that is not a set after the sets by name, and every detail page is a plain link. Filters and sorting are an enhancement.
- **Accessible** (`HANDOVER.md` §8): alt text on every image, AA contrast in both themes, keyboard focus visible in `--focus` blue, and filters as real form controls.
- **Nothing to discover.** `noindex` on every response (`[PUB-2]`), no sitemap, no analytics, and no third-party request except the catalogue's own stock images.

## Pages

### Landing (`/c/{token}/`)

```
┌───────────────────────────────┐
│ Plinthos                       │
│ A LEGO collection              │
├───────────────────────────────┤
│ {intro text}                   │
├───────────────────────────────┤
│  142 sets · 12 other · 180 items│
│  Sealed 40 · Used, box 70 ·    │
│  Used, no box 32               │
│  Loose parts 48,210 in 1,930 lots│
├───────────────────────────────┤
│ [All] [Sealed] [Used, box] [..]│  condition chips
│ Kind  [ All kinds       ▾]     │  only with more than one kind
│ Theme [ All themes      ▾]     │
│ Sort  [ Set number      ▾]     │
├───────────────────────────────┤
│ ┌────┐ ┌────┐                  │  two columns on a phone,
│ │img │ │img │                  │  four or more on a wide screen
│ └────┘ └────┘                  │
│ 10294-1 75192-1                │
│ Titanic Millennium F.          │
│ Sealed  Used, box              │
│  …                             │
├───────────────────────────────┤
│ Loose parts                    │
│ [▣][▣][▣]  48,210 parts        │
├───────────────────────────────┤
│ Contact                        │
│ {contact text}                 │
└───────────────────────────────┘
```

### Set detail (`/c/{token}/s/{item-id}/`)

```
┌───────────────────────────────┐
│ ← All sets                     │
│ 10294-1 Titanic                │
│ Icons · 2021 · 9,090 pieces    │
├───────────────────────────────┤
│ ┌───────────────────────────┐ │  the gallery: the owner's photos,
│ │        photo 1 / 4        │ │  then the stock image, swipeable,
│ └───────────────────────────┘ │  with a strip of thumbnails; a tap opens the full size
│ [▣][▣][▣][▣][stock]           │
├───────────────────────────────┤
│ Condition    Sealed            │
│ Complete     Yes               │
│ Instructions Yes               │
│ Quantity     1                 │
│ {description}                  │
└───────────────────────────────┘
```

When the set isn't complete, "What's missing" follows Complete, with the owner's note.

A minifigure, bulk lot or other item (#202) has the same page without a set number, theme, year, piece count or stock image: the heading is its name, the muted line says what it is (`Minifigure`, `Bulk lot`, `Other item`), and the facts start with its reference number and a bulk lot's approximate pieces and weight (`about 2,500 pieces`, `3,200 g`). Complete and Instructions appear only when the owner stated them. Its card shows the reference number in the set number's place, when it has one, and the muted line says what it is, with a bulk lot's approximate numbers: `Bulk lot · about 2,500 pieces · about 3,200 g`.

### Parts (`/c/{token}/parts/`)

The overview photos as a gallery, and the summary: the lots and the loose parts. With selling mode off it has no lot list and no values. In selling mode it is the loose parts' split view (below).

## Values and selling mode (#211)

Everything here appears only when the data holds it, and the projection puts it there only when the settings show it (`[PUB-17]`, `[PUB-18]`). With every switch off, the pages are exactly the ones above.

- **Market values** (Show values, or selling mode with `MARKET` or `BOTH`): a card adds its value under the condition chip (`€1,234.00`, 14 px bold); the item's page adds "Estimated value  €1,234.00 estimated, as of 29 October 2026" after Quantity; the landing's summary adds `Estimated value €1,704.49 · Sealed €1,234.00 · Used €130.49 · Loose parts €340.00`, and the sort select adds "Value, highest first", items without a value last. An item without a value shows nothing.
- **Asking prices** (selling mode with `ASKING` or `BOTH`): the summary adds `Asking price €1,500.00 · Sealed €1,100.00 · Used €120.00 · Loose parts €280.00`, each part only when entered. With `ASKING` alone there is no value anywhere and no value sort.
- **Split views** (selling mode, `[PUB-19]`): the summary links to "Sealed items only" (`sealed/`), "Used items only" (`used/`) and "Loose parts only" (`parts/`), each only when it holds something. The segments are `segmentOf`'s (`src/server/valuation/values.ts`, `[VAL-7]`): a minifigure is used, a bulk lot is loose parts. Each view has the landing's cards, without filters, and under its heading the subtotal the display shows: `Estimated value €1,234.00 · Asking price €1,100.00`. The parts view adds the bulk lots' cards.
- **Parts download** (selling mode, `[PUB-20]`, #5): "Parts list" on the landing's parts section and the parts view, with "Download as CSV" (`parts.csv`) and "Download as BrickLink XML" (`parts.xml`, which BrickStore opens). Each lot is its item type, number, colour id, condition and quantity, and its unit price only with market values.

## Components

- **Set card:** a square thumbnail (`object-fit: cover`, `--surface` behind it), set number in 14 px bold, name in 14 px, condition as a small chip. The whole card is one link.
- **Chips and selects:** the admin's chip group and a native `<select>`, so the phone shows its own picker.
- **Gallery:** horizontal scroll snap on a phone, with arrow buttons on a wide screen. Each slide is an `<img>` with `loading="lazy"` after the first.
- **Empty states:** "Nothing is published yet." (the placeholder that already exists) and "Nothing matches these filters."

## Data the pages read

One `catalogue.json` in the snapshot, format 4 since #211 (3 since #202), holds what the pages are rendered from: for each item, its id, kind, set number, name (the set's, or a non-set's own), reference number, theme, year, piece count, a bulk lot's approximate pieces and weight, condition, completeness, missing notes, instructions, description, quantity, stock image URL and public photo keys. It also holds the texts and the parts summary. For an item that is not a set, the set number, theme, year, piece count and stock image are null, and completeness and instructions are null when not stated. Format 4 adds optional fields, each **absent** when the settings hide it, never null: an item's `value` and `asOf` (a day), and in selling mode its `segment`; the parts' `value` and, in selling mode, `list` of lots (`type`, `no`, `color`, `condition`, `quantity`, and `price` with market values); and `valueCurrency`, `totals` (`all`, `sealed`, `used`, `parts`), `asking` (`total`, `sealed`, `used`, `parts`) and `segments`. It holds nothing the projection doesn't put there (`[PUB-5]`). The script never reads it: it filters and sorts the grid's cards from their own `data-*` attributes, which the landing renders from the same data.
