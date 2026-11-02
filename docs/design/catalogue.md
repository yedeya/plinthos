# Public catalogue design

The visitor's side: a static, read-only showcase of one collection, opened from a shared link, usually on a phone. It is served from the snapshot and never touches the database (`AGENTS.md` §1). It reuses the admin's tokens (`docs/design/ui.md`) and its brick-red accent, with more room for photos. Values, prices, split views and the parts download come with the valuation milestone.

## Principles

- **Photos first.** The owner's own photos show the real condition, so they are large and swipeable, with the stock image beside them.
- **Fast on a phone over a poor connection.** Static HTML and one small script. Thumbnails are 320 px and lazy. Full sizes load only on the detail page.
- **Works without the script.** The grid is in the HTML, sorted by set number, and every detail page is a plain link. Filters and sorting are an enhancement.
- **Accessible** (`HANDOVER.md` §8): alt text on every image, AA contrast in both themes, keyboard focus visible, and filters as real form controls.
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
│  142 sets · 168 items          │
│  Sealed 40 · Used, box 70 ·    │
│  Used, no box 32               │
│  Loose parts 48,210 in 1,930 lots│
├───────────────────────────────┤
│ [All] [Sealed] [Used, box] [..]│  condition chips
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
│ └───────────────────────────┘ │  with dots; a tap opens the full size
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

### Parts (`/c/{token}/parts/`)

The overview photos as a gallery, and the summary: the lots and the loose parts. In this milestone it has no lot list and no values.

## Components

- **Set card:** a square thumbnail (`object-fit: cover`, `--surface` behind it), set number in 14 px bold, name in 14 px, condition as a small chip. The whole card is one link.
- **Chips and selects:** the admin's chip group and a native `<select>`, so the phone shows its own picker.
- **Gallery:** horizontal scroll snap on a phone, with arrow buttons on a wide screen. Each slide is an `<img>` with `loading="lazy"` after the first.
- **Empty states:** "Nothing is published yet." (the placeholder that already exists) and "No sets match these filters."

## Data the pages read

One `catalogue.json` in the snapshot holds what the pages render and what the script filters: for each item, its id, set number, name, theme, year, piece count, condition, completeness, missing notes, instructions, description, quantity, stock image URL and public photo keys. It also holds the texts and the parts summary. It holds nothing the projection doesn't put there (`[PUB-5]`).
