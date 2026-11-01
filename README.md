# Plinthos

*πλίνθος: Greek for "brick".*

Plinthos is a self-hosted catalogue for a LEGO® collection. You deploy your own copy, register each set from your phone, import your loose parts from a BrickLink or BrickStore inventory file, and share a fast, read-only showcase of the collection with whoever you choose: real photos, the condition, and what is in each set.

**Selling the collection as a lot** is an optional mode. Switch it on and the public catalogue becomes an offer you can link from any marketplace listing, with estimated values, asking prices, split views and a downloadable parts list. It is still **not a shop**: there is no checkout, no selling items one by one, and no syncing listings with marketplaces.

Each deployment has **one owner**. There are no sign-ups and no shared hosting: anyone who wants a catalogue deploys their own copy to their own AWS account.

> **Status:** the walking skeleton is being built ([`docs/projects/6.md`](docs/projects/6.md)): no catalogue feature exists yet. [`docs/deploy.md`](docs/deploy.md) deploys what there is. The product intent is in [`HANDOVER.md`](HANDOVER.md); its technical section is superseded by the stack below and by the briefs in `docs/projects/`.

## What it will do

**For the owner** (an installable web app, built for the phone):
- **Fast set entry, repeated 100+ times:**
  - Find a set by keyword or set number, with name, theme, year and stock image filled in from Rebrickable.
  - Add your own photos.
  - Record condition (sealed, used with box, used without box), completeness, instructions and a short note.
  - Then save and add the next set.
- **Works offline.** Entries and photos are queued on the phone and synced when there is signal again.
- **Parts import** from a BrickLink XML or BrickStore `.bsx` file, showing lots, total parts and total value.
- **Valuation:** BrickLink price-guide averages per set and condition, each with its source and "as of" date. You can override any value. Values are private unless you choose to show them.

**For visitors** (a public, unlisted link):
- A summary of the collection, a set grid with filters, sorting and keyword search, and a detail page per set.

**Selling mode** (optional, for owners who want to sell the collection as a lot):
- Asking prices per segment, and estimated values shown to buyers.
- Split views (sealed only, used only, parts only), each with its own subtotal.
- A downloadable parts list, as CSV and as BrickLink XML, generated from the imported lots without prices or remarks.

## How it is built

- **TypeScript**, deployed with **SST** to **AWS**, in a region each deployment configures (Frankfurt for the reference deployment). Next.js on Lambda, and Aurora Serverless v2 PostgreSQL that pauses when idle.
- Photos and the public catalogue live in **S3** and are served by **CloudFront**.
- **The public catalogue is a static snapshot** that the publish step generates. It holds only public data, so private fields (such as where a set is stored) can't leak, and visitors' pages never wait for a sleeping database.
- **Photos are re-encoded on upload**, so no GPS or device metadata is ever published.
- **Nothing runs all the time.** The target running cost is under $10 a month per deployment.
- **Everything owner-specific is configuration.** Your name, admin account, API keys, currency, AWS region and catalogue settings come from your own deployment's configuration and secrets, never from the code.

The project's rules for security, observability and cost are in [`AGENTS.md`](AGENTS.md).

## Workflow

Development follows the [Kanon](https://github.com/yedeya-labs/kanon) agentic workflow. Work starts as a brief in `docs/projects/`, is broken down into issues, and lands as reviewed pull requests.

## Trademarks

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project. BrickLink, BrickStore, Rebrickable and Brickset are the property of their respective owners.
