# Plinthos

*πλίνθος: Greek for "brick".*

Plinthos is a catalogue for selling a LEGO® collection as one lot. The owner registers each set from a phone and imports the loose parts from a BrickLink or BrickStore inventory file. Buyers get a fast, read-only catalogue they can open from any marketplace listing, showing what is in the lot, real photos, the condition, and an estimated value.

It is **not a shop**: there is no checkout, no selling items one by one, and no syncing listings with marketplaces.

> **Status:** design phase. There is no code yet. The product intent is in [`HANDOVER.md`](HANDOVER.md); its technical section is superseded by the stack below and by the briefs to come in `docs/projects/`.

## What it will do

**For the owner** (an installable web app, built for the phone):
- **Fast set entry, repeated 100+ times:**
  - Find a set by keyword or set number, with name, theme, year and stock image filled in from Rebrickable.
  - Add your own photos.
  - Record condition (sealed, used with box, used without box), completeness, instructions and a short note.
  - Then save and add the next set.
- **Works offline.** Entries and photos are queued on the phone and synced when there is signal again.
- **Parts import** from a BrickLink XML or BrickStore `.bsx` file, showing lots, total parts and total value.
- **Valuation:** BrickLink price-guide averages per set and condition, each with its source and "as of" date. You can override any value, or set an asking price per segment.

**For buyers** (a public, unlisted link):
- A summary of the lot, a set grid with filters, sorting and keyword search, and a detail page per set.
- Split views (sealed only, used only, parts only), each with its own subtotal.
- A downloadable parts list, as CSV and as the original BrickLink XML.

## How it is built

- **TypeScript**, deployed with **SST** to **AWS** (Frankfurt). Next.js on Lambda, and Aurora Serverless v2 PostgreSQL that pauses when idle.
- Photos and the public catalogue live in **S3** and are served by **CloudFront**.
- **The public catalogue is a static snapshot** that the publish step generates. It holds only public data, so private fields (such as where a set is stored) can't leak, and buyers' pages never wait for a sleeping database.
- **Photos are re-encoded on upload**, so no GPS or device metadata is ever published.
- **Nothing runs all the time.** The target running cost is under $10 a month.

The project's rules for security, observability and cost are in [`AGENTS.md`](AGENTS.md).

## Workflow

Development follows the [Kanon](https://github.com/yedeya-labs/kanon) agentic workflow. Work starts as a brief in `docs/projects/`, is broken down into issues, and lands as reviewed pull requests.

## Trademarks

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project. BrickLink, BrickStore, Rebrickable and Brickset are the property of their respective owners.
