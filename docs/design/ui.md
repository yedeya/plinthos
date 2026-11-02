# Admin UI design

The basic design of the owner's admin: a phone-first, installable web app used one-handed, often in a storage room with poor light and no signal. It covers set entry (#124) and restyles the pages that exist today. The public catalogue gets its own design with its milestone.

## Principles

- **Thumb first.** Primary actions sit at the bottom of the screen, every tap target is at least 44 × 44 px, and nothing important needs a long press or a hover.
- **One screen per job.** Logging a set is one scroll with one sticky button, repeated 100+ times. Every extra tap is multiplied.
- **The state is visible.** Online or offline, the count of changes still to sync, and anything held for the owner are always in view, as a chip in the header, not hidden in a menu.
- **Plain and legible.** System fonts, high contrast, light and dark themes from the device setting. No images except the owner's photos and the set's stock image.
- **No framework.** One stylesheet of tokens and a few component classes (`src/app/admin.css`), loaded by the admin's layout and by the offline shell. No CSS framework, no component library, no web font. Every UI text lives in one message file (`src/app/messages/en.ts`), as `HANDOVER.md` §10.9 asks.

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f5f6f8` | `#121418` | page background |
| `--surface` | `#ffffff` | `#1c1f25` | cards, sheets, inputs |
| `--ink` | `#1a1d23` | `#e8eaee` | text |
| `--muted` | `#5d6573` | `#9aa3b2` | secondary text, hints |
| `--line` | `#dde1e7` | `#2e333c` | borders, dividers |
| `--accent` | `#c8102e` | `#ff5a6e` | primary button, selected chip, focus ring (brick red) |
| `--ok` | `#1f7a3d` | `#4cc27a` | synced, saved |
| `--warn` | `#a35a00` | `#f0a640` | offline, pending |
| `--danger` | `#b3261e` | `#ff8a80` | conflict, failed, delete |

- **Type:** the system UI stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`). Sizes 14 / 16 / 20 / 24 px. The body is 16 px, which keeps iOS from zooming into inputs.
- **Spacing:** a 4 px scale (4, 8, 12, 16, 24, 32). The page gutter is 16 px, except on the overview (`/admin`), whose gutter is 8 px on a phone and 24 px from 720 px (#203).
- **Shape:** an 8 px radius on cards and inputs, 999 px on chips, and a 1 px `--line` border. No shadows, except on the sticky action bar.
- **Focus:** a 2 px `--accent` outline with a 2 px offset on every interactive element.

## Components

| Component | What it is |
|---|---|
| **Header** | The page title on the left, the status chip on the right: `● Online`, `● Offline` (`--warn`), `3 to sync`, `Uploading 3/8` while a sync uploads photos (in place of `3 to sync`, #203), `1 needs you` (`--danger`, links to the held list). |
| **Chip group** | A single choice from 2 to 4 options as pills (`Sealed`, `Used, box`, `Used, no box`): a radio group underneath, keyboard-operable. |
| **Toggle row** | A label on the left and a yes/no segmented control on the right (Complete, Instructions). |
| **Stepper** | `−  1  +` for quantity, with the number also typeable. |
| **Set result** | The stock image (64 px), `10294-1 Titanic`, and `Icons · 2021 · 9,090 pcs` muted beneath; tap to choose it. |
| **Photo strip** | A horizontal row of 72 px square thumbnails after an `Add photo` tile with a camera icon. Tapping a thumbnail opens a small sheet: *Make cover*, *Move left*, *Move right*, *Remove*. The cover shows `★`. |
| **Action bar** | Sticky at the bottom, above the safe area: the primary button (`Save & add next`, full-width `--accent`) and a secondary one (`Save`). |
| **Item row** | The cover thumbnail (56 px), `10294-1 Titanic`, and `Sealed · ×2` muted beneath. `Not synced` or `Needs you` as a chip on the right. In the overview's grid (from 720 px) each row is a card of its own. |
| **Toast** | A one-line confirmation at the bottom, above the action bar, for 3 seconds: `Saved 10294-1 · 3 photos`. |
| **Save progress** | Where the toast sits, while **Save** waits for its own sync (#203): a `<progress>` bar (8 px, `--accent` on `--line`) over `Uploading photos 3 of 8`, then an indeterminate bar over `Saving…` once the photos are up and the server stores them. Driven by the sync's upload loop (`QUEUE_PROGRESS`). Each photo uploaded gives the wait another 8 s, and it never passes 60 s, after which the items open with the set marked not synced. |
| **Loading screen** | `src/app/admin/loading.tsx` (#203): a 40 px spinner ring (`--line`, its top quarter `--accent`) centred over `Loading…` and the muted line `Waking the database. After a quiet spell this can take up to half a minute.` Shown at once on opening any admin page, while the server waits for the database. With reduced motion the ring stands still. It holds no data, so it is the same for everyone (`[AUTH-4]`, `[PLAT-16]`). |

## Screens

### Items (`/admin`), the home

```
┌─────────────────────────────┐
│ Plinthos          ● 2 to sync│
├─────────────────────────────┤
│ 🔍 [Filter by number or name]│
├─────────────────────────────┤
│ [▣] 10294-1 Titanic          │
│     Sealed · ×1   Not synced │
│ [▣] 75192-1 Millennium Falcon│
│     Used, box · ×1           │
│ [▣] 21318-1 Tree House       │
│     Used, no box · ×2        │
│  …                           │
├─────────────────────────────┤
│ 142 sets · 168 items         │
│ Publish · Photos · Sign out  │
├─────────────────────────────┤
│ [        + Add set         ] │
└─────────────────────────────┘
```

On a phone the overview's gutters are 8 px, so the list uses the screen. From 720 px the page widens to 1200 px and the list becomes a grid of cards, two columns and then three from 1100 px; the action bar widens with it and keeps **Add set** to 360 px on the right. Every other page, the entry form and the settings among them, stays one column of 640 px.

The list is newest first and filters as you type, by set number, name or reference number. A minifigure, bulk lot or other item (#202) shows its own name, with a small chip saying what it is (`Minifigure`, `Bulk lot`, `Other`), and never a stock image: its thumbnail is its cover, else the empty tile. The summary counts the sets, then the other items when there are any: `142 sets · 12 other · 180 items`. A tap opens the item in the entry form. **Add set** is the sticky primary action. Publish, the stored-photos page and Sign out move into the footer. The held list (conflicts, `unknown-set`) sits above the items when it isn't empty.

### Add or edit a set (`/admin/items/new`, `/admin/items/[id]`)

```
┌─────────────────────────────┐
│ ← Items        Add set   ●  │
├─────────────────────────────┤
│ Set number or name          │
│ 🔍 [10294                 ] │
│ Will save as 10294-1        │
│ ┌───┐ 10294-1 Titanic       │
│ │img│ Icons · 2021 · 9090 pc│
│ └───┘                  ✓    │
├─────────────────────────────┤
│ Photos                      │
│ [📷+] [▣★] [▣ ] [▣ ]        │
├─────────────────────────────┤
│ Condition                   │
│ (Sealed)(Used, box)(No box) │
│ Complete     [ Yes | No ]   │
│   └ What's missing [      ] │  (shown only when No)
│ Instructions [ Yes | No ]   │
│ Quantity     [ −  1  + ]    │
│ Description  [            ] │
│ Storage 🔒   [Attic box 3  ] │
├─────────────────────────────┤
│ [  Save & add next  ] [Save]│
└─────────────────────────────┘
```

- **Set field:** one field, *Set number or name*. Results appear after 2 characters, at most 10, about 1 second after the last keystroke when the text is digits (`10294`, `10294-2`) and about 0.5 seconds otherwise; newer text aborts the search before it. Choosing one collapses the field to the chosen set's card, with a *Change* link. Text that reads as a set number saves without a pick, with a hint under the field: "Will save as 10294-1" when the results hold that set, otherwise "Will save as 10294-1; details are filled in when it syncs". A name with nothing picked asks to pick a set. Offline, on the shell, or when search isn't answering (`[CAT-5]`), the same field stays, sends nothing or shows the quiet line "Search isn't answering right now; you can still save by set number", and there is no mode to switch.
- **Storage** carries a lock icon and the hint "Private, never published".
- **Not a set** (#202): with no set chosen and text that isn't a set number, a row under the results reads *Not a set? Log it as* with three buttons, **Minifigure**, **Bulk lot** and **Other**; and a quiet **Not a set?** link sits under the field at all times. Either swaps the set field for the item's own fields: the kind as three choices, *Name* (prefilled with the typed text), *Reference number* (optional, "a figure number such as sw0001, or a BrickLink item number"), and for a bulk lot *Approximate pieces* and *Approximate weight (g)*, both optional. Complete and Instructions gain a third choice, *Not stated*, which they start at. **It’s a set** goes back, the name becoming the set field's text. Nothing here needs the network, so the offline shell is the same.
- **Save & add next** queues the item and its photos, shows the toast, scrolls to the top and focuses the search, or the name field for a non-set. The kind, the condition and the storage location stay as they were.
- **Save** queues the item and returns to Items. Editing an existing item shows only **Save**, plus **Delete set** as quiet red text at the top of the form, far from Save, which asks for confirmation.
- **Validation** is inline, under the field, in `--danger`. Nothing is lost on an error.

### Offline shell (`/offline`)

The same entry form, its set field sending no request, the queue's status, and the queued items, read from the device. There is no server data, because the shell stays data-free (`[SYNC-6]`).

### Sign in (`/login`)

A centred card on `--bg` with the wordmark, username, password and a full-width **Sign in** button. Errors show inline ("Wrong username or password", "Too many attempts, try again in 15 minutes").
