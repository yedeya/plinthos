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
| `--accent` | `#c8102e` | `#ff5a6e` | primary button, selected chip (brick red) |
| `--ok` | `#1f7a3d` | `#4cc27a` | synced, saved |
| `--warn` | `#a35a00` | `#f0a640` | offline, pending |
| `--danger` | `#b3261e` | `#ff8a80` | conflict, failed, delete |
| `--focus` | `#1d63d8` | `#7ab0ff` | the focus outline: blue, so a focused field never reads as an error |

- **Type:** the system UI stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`). Sizes 14 / 16 / 20 / 24 px. The body is 16 px, which keeps iOS from zooming into inputs.
- **Spacing:** a 4 px scale (4, 8, 12, 16, 24, 32). The page gutter is 16 px.
- **Shape:** an 8 px radius on cards and inputs, 999 px on chips, and a 1 px `--line` border. No shadows, except on the sticky action bar.
- **Focus:** a 2 px `--focus` outline with a 2 px offset on every interactive element. It is never red: the form focuses the set search after Save & add next, and a red outline there read as an error.

## Components

| Component | What it is |
|---|---|
| **Header** | The page title on the left, the status chip on the right: `● Online`, `● Offline` (`--warn`), `3 to sync`, `1 needs you` (`--danger`, links to the held list). |
| **Chip group** | A single choice from 2 to 4 options as pills (`Sealed`, `Used, box`, `Used, no box`): a radio group underneath, keyboard-operable. |
| **Toggle row** | A label on the left and a yes/no segmented control on the right (Complete, Instructions). |
| **Stepper** | `−  1  +` for quantity, with the number also typeable. |
| **Set result** | The stock image (64 px), `10294-1 Titanic`, and `Icons · 2021 · 9,090 pcs` muted beneath; tap to choose it. |
| **Photo strip** | A horizontal row of 72 px square thumbnails after an `Add photo` tile with a camera icon. Tapping a thumbnail opens a small sheet: *Make cover*, *Move left*, *Move right*, *Remove*. The cover shows `★`. |
| **Action bar** | Sticky at the bottom, above the safe area: the primary button (`Save & add next`, full-width `--accent`) and a secondary one (`Save`). |
| **Item row** | The cover thumbnail (56 px), `10294-1 Titanic`, and `Sealed · ×2` muted beneath. `Not synced` or `Needs you` as a chip on the right. |
| **Toast** | A one-line confirmation at the bottom, above the action bar, for 3 seconds: `Saved 10294-1 · 3 photos`. |

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

The list is newest first and filters as you type. A tap opens the item in the entry form. **Add set** is the sticky primary action. Publish, the stored-photos page and Sign out move into the footer. The held list (conflicts, `unknown-set`) sits above the items when it isn't empty.

### Add or edit a set (`/admin/items/new`, `/admin/items/[id]`)

```
┌─────────────────────────────┐
│ ← Items        Add set   ●  │
├─────────────────────────────┤
│ 🔍 [10294 tit             ] │
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

- **Search:** results appear after 2 characters, debounced by 300 ms, at most 10. Choosing one collapses the search to the chosen set's card, with a *Change* link. Offline, or when search is unavailable (`[CAT-5]`), the field becomes `Set number` with the hint "Saved now, details filled in when it syncs".
- **Storage** carries a lock icon and the hint "Private, never published".
- **Save & add next** queues the item and its photos, shows the toast, scrolls to the top and focuses the search. The condition and the storage location stay as they were.
- **Save** queues the item and returns to Items. Editing an existing item shows only **Save**, plus **Delete set** as quiet red text at the top of the form, far from Save, which asks for confirmation.
- **Validation** is inline, under the field, in `--danger`. Nothing is lost on an error.

### Offline shell (`/offline`)

The same entry form with typed set numbers, the queue's status, and the queued items, read from the device. There is no server data, because the shell stays data-free (`[SYNC-6]`).

### Sign in (`/login`)

A centred card on `--bg` with the wordmark, username, password and a full-width **Sign in** button. Errors show inline ("Wrong username or password", "Too many attempts, try again in 15 minutes").
