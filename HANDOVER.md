# Hand-over: LEGO Collection Catalogue

> For the Claude Code session that builds this app. Read it fully, then **confirm the open questions in §10 with Geoffry before you write any code.** He prefers to be asked rather than have things assumed, and wants only what's requested built — no extras.

---

> **Reframed on 2026-11-01:** Plinthos is a **self-hosted catalogue for any LEGO collection**. Anyone can deploy their own copy, with one owner per deployment. Selling a collection as a lot, Geoffry's own purpose, becomes an optional **selling mode**, off by default. The sections below are updated to match. Where they describe Geoffry's collection, read it as the first deployment and the reference user, not as the product's limit.

## 1. Goal

Any LEGO collector can deploy Plinthos to **catalogue their collection** and share a read-only showcase of it. Each owner needs:

1. **A mobile-first input tool** to register each set from their phone: own photos, short description, condition, and optionally an estimated value.
2. **An import** of loose parts from an existing BrickLink XML or BrickStore `.bsx` inventory file.
3. **A public, read-only catalogue website** they can share by link. It shows the contents, their photos and the condition.

**Selling mode** (optional, built first for Geoffry's purpose): Geoffry has a large LEGO collection that he wants to **sell as one lot** (or, if a buyer insists, split into sub-lots) on several platforms (marketplaces, auction sites, classifieds — not decided). With selling mode on, the public catalogue becomes the offer he links from every listing: it adds values and asking prices, and a split view (sealed / used / parts) with subtotals.

Even in selling mode this is **not** a shop. No checkout, no per-item selling, no BrickLink listing sync.

## 2. The reference collection (Geoffry's, as he described it)

The first deployment, and the size the app must handle comfortably. Other owners' collections may be smaller, larger, or have no loose parts at all.

| Segment | Size | Notes |
|---|---|---|
| Sealed sets | part of 100+ sets | New, factory-sealed |
| Used sets, with box | part of 100+ sets | Good condition |
| Used sets, without box | part of 100+ sets | |
| Loose new parts | ~50,000 parts | From his old BrickLink store. He believes he still has the inventory file (BrickLink XML and/or BrickStore `.bsx`) |

Photos: **his own photos showing the actual condition**, optionally next to a stock/catalogue image.

## 3. Users and access

- **Owner**: one admin account per deployment, created from the deployment's configuration. Adds and edits items on their phone, uploads photos, imports parts, and, in selling mode, sets prices.
- **Visitors**: anonymous, read-only access to the public catalogue, through a link the owner shares. In selling mode they are potential buyers arriving from a listing on any platform, often on mobile.
- No other roles. A deployment serves one owner; someone else who wants a catalogue deploys their own copy.

## 4. Functional scope

### 4.1 Set entry (admin, phone-first)
- Find a set by **set number or name** (autocomplete from the Rebrickable catalogue). Fill in name, theme, year, piece count and stock image automatically.
- *Nice to have:* **scan the box barcode** (EAN/UPC) to identify the set. Brickset's set data includes EAN and UPC fields. Only offer this if §10 confirms it.
- Fields per item:
  - `condition`: `SEALED` | `USED_WITH_BOX` | `USED_NO_BOX`
  - `completeness`: complete / incomplete (+ free text listing what's missing)
  - `has_instructions`: yes / no
  - `description`: short free text (box damage, sun fade, stickers applied, etc.)
  - `quantity` (duplicates of the same set)
  - `storage_location`: **private**, never shown publicly
  - `market_value` (auto, see §6) and an optional `manual_value_override`
- **Photos**: several per item, taken straight from the phone camera (`<input type="file" accept="image/*" capture>`) or picked from the gallery. Resize and compress on the client before upload. **Strip EXIF (especially GPS) on the server** before storing. Reorder photos and pick a cover photo.
- The entry flow must be fast to repeat 100+ times: one screen, thumb-friendly, with a "save & add next" button.
- Works on a poor connection. An installable PWA is fine. Offline queueing is only needed if §10 asks for it.

### 4.2 Parts import (admin)
- Import a **BrickLink XML** inventory export and/or a **BrickStore `.bsx`** file (BSX is XML too). Fields to keep per lot: item type, item no, colour, condition, quantity, price if present.
- Show a summary: number of lots, total parts, total value.
- The import must be repeatable (replace the parts inventory). It is not a merge editor.
- Allow a handful of **overview photos** for the parts lot as a whole (sorted drawers, bags, etc.).

### 4.3 Public catalogue
- Landing page: collection summary (number of sets per condition, total parts), a short intro text from the owner, and contact instructions (text only — no contact form unless §10 asks for one).
- Set grid with filters (condition, theme) and sorting (set number, year, name).
- Set detail page: own photos (gallery) + stock image, condition, completeness, description.
- Parts section: summary (lots and parts, no values) and overview photos.
- **Values and asking prices are hidden by default.** Whether a value reaches the public catalogue depends only on the current settings, never on whether a value or asking price happens to be stored: an asking price entered in selling mode is not published once selling mode is off. Nothing derived from a hidden value is published either, including totals, subtotals and a sort by value (its order would reveal each set's rank).
- **Show values** (admin toggle, off by default): the owner shows estimated market values without selling. This adds the value per set on the grid and detail page, totals per segment on the landing page, and sorting by value.
- **Selling mode** (admin toggle, off by default) adds:
  - a value display choice: market values, asking prices only, or both (asking prices per segment and overall, on the landing page);
  - sorting by value, using the values that are displayed;
  - **split views**: "sealed sets only", "used sets only" and "parts only", each with its own subtotal, so a buyer interested in only part of the lot sees a coherent offer;
  - a **downloadable parts list** (CSV and BrickLink XML, so a buyer can check it in BrickStore/BrickLink themselves). It is generated from the imported lots and holds only public fields, never the uploaded file as it arrived: per-lot prices and remarks (which often hold bin locations) are left out (#5).
- Unlisted by default: put a secret token in the URL (`/c/{token}`) and add `noindex`. Let the owner rotate the token.
- Fast and light on mobile (lazy-loaded thumbnails, responsive image sizes).

### 4.4 Export (admin)
- CSV of all sets (for platforms that want a list pasted or attached).
- A one-page printable summary (HTML print stylesheet is enough) with totals per segment.

## 5. Non-goals
- No selling, cart, payments or BrickLink/Brick Owl listing sync. (Selling mode only presents the collection as an offer.)
- No multi-user or family accounts, no sign-up, and no hosted multi-tenant service: one owner per deployment.
- No collectibles other than LEGO.
- No per-part photos and no part-by-part editing UI.
- No loose minifigure tracking unless §10 says otherwise (minifigs inside sets are covered by the set).

## 6. Valuation

Market prices for LEGO are estimates. Store the **source and the date** of every value and show "estimated, as of {date}" in the catalogue.

| Need | Source | Notes |
|---|---|---|
| Set catalogue data + stock image | **Rebrickable API v3** | Free API key, sent as an `Authorization: key …` header. Handle HTTP 429 throttling with backoff. It has **no prices**, and returns only one image per set. |
| Set market value (new vs used) | **BrickLink API** price guide (`/items/SET/{no}/price`, `guide_type=sold`, `new_or_used=N/U`, 6-month average) | OAuth 1.0a (HMAC-SHA1) using a consumer key/secret plus an access token/secret. **Tokens are bound to registered IP addresses**, so the cluster's egress IP must be fixed and registered (or run the price refresh from a fixed-IP job). Some client libraries say a BrickLink **seller registration** is required; Geoffry had a store. |
| Alternative set value | **BrickEconomy API** | Requires Premium (about 100 requests/day). Optional — only if §10 chooses it. |
| Parts value (~50k parts, many lots) | **Offline via BrickStore** | Don't call the BrickLink API once per lot. Geoffry loads the file in BrickStore, sets the price to the BrickLink 6-month average, saves, and the app imports the priced file. The app only adds up the totals. |
| Barcode → set (optional) | **Brickset API v3** `getSets` | Needs an API key, about 100 `getSets` calls per day by default. |

Rules:
- Cache prices in the database. Refresh only on demand (admin button) or on a slow schedule — never on public page views.
- Value per set = price for its condition (`SEALED` → new; `USED_*` → used) × quantity, unless `manual_value_override` is set.
- A used set without a box is usually worth less than the used average. Don't invent a discount: store an optional admin-set percentage adjustment per condition, defaulting to 0 %, and confirm this in §10.
- Currency: set per deployment (EUR for Geoffry's, unless §10 says otherwise).

## 7. Proposed architecture (defaults — confirm in §10)

Matches Geoffry's usual stack:

- **Backend**: Java 21 + Spring Boot 3, Maven. REST API. Flyway migrations. Spring Security with one admin login (session or OIDC — confirm). Public endpoints are read-only and token-scoped.
- **Database**: PostgreSQL.
- **Frontend**: SvelteKit + TypeScript. One app with an `/admin` area (PWA, mobile-first) and the public `/c/{token}` catalogue. Prerender or cache public pages where it helps.
- **Photo storage**: S3-compatible object storage (e.g. MinIO in the cluster, or a managed bucket). Keep originals plus generated sizes (thumb / medium / large, WebP). Server-side processing with EXIF stripping.
- **Deployment**: Kubernetes (Deployment + Service + Ingress with TLS, a CronJob for price refresh, Secrets for API keys). Provide a `docker-compose.yml` for local development.
- **Integrations** behind small interfaces (`CatalogProvider`, `PriceProvider`) so BrickLink can be swapped for BrickEconomy.

### Draft data model
```
lego_set_catalog(set_num PK, name, theme, year, num_parts, stock_image_url, ean, upc, fetched_at)
collection_item(id PK, set_num FK, condition, complete bool, missing_notes, has_instructions,
                description, quantity, storage_location /*private*/, manual_value_override,
                created_at, updated_at)
item_photo(id PK, item_id FK, storage_key, sort_order, is_cover, width, height, created_at)
price_quote(id PK, set_num, condition_class /*NEW|USED*/, source, avg_price, currency,
            sample_size, fetched_at)
parts_import(id PK, filename, format /*BL_XML|BSX*/, imported_at, total_lots, total_qty, total_value)
parts_lot(id PK, import_id FK, item_type, item_no, color_id, condition, qty, unit_price)
parts_photo(id PK, storage_key, sort_order)
catalogue_settings(id PK, public_token, intro_text, contact_text,
                   show_values /*showcase: show market values; default false*/,
                   selling_mode /*default false*/,
                   selling_value_display /*MARKET|ASKING|BOTH; read only when selling_mode*/,
                   asking_price_total, asking_price_sealed, asking_price_used, asking_price_parts,
                   used_no_box_adjust_pct, currency)
```

## 8. Quality bar
- Tests: unit tests for the BSX/XML parser (sample files included in the repo) and the valuation logic. Integration tests against Postgres (Testcontainers). Mock the external APIs.
- Never expose `storage_location`, admin fields, or a value or asking price the current settings hide through public endpoints or the snapshot. Add a test that checks this for each combination of `show_values`, `selling_mode` and `selling_value_display`.
- Keep secrets (API keys, BrickLink OAuth) out of the repo.
- Rate-limit and back off on every external API.
- Accessibility basics on the public site (alt text, contrast, keyboard navigation).

## 9. Milestones
1. **Skeleton**: repo, docker-compose, Spring Boot + SvelteKit + Postgres, admin login, deployable to k8s.
2. **Set entry**: Rebrickable search, item form, photo upload (resize + EXIF strip), item list. → *Geoffry can start entering sets from his phone.*
3. **Parts import**: BSX/XML parser, summary, overview photos, downloadable list (selling mode).
4. **Public catalogue**: token URL, summary, grid, detail, noindex; split views (selling mode).
5. **Valuation**: BrickLink price guide caching, per-segment totals, overrides, asking prices, "as of" dates.
6. **Export & polish**: CSV, printable summary, optional barcode scan.

Ship milestone 2 early, so data entry (the slowest part, and done in the real world) can start while the rest is built.

## 10. Open questions — ask Geoffry before building
1. **Hosting**: deploy on his own Kubernetes cluster (which one; does it have a fixed egress IP for the BrickLink API?), or somewhere simpler?
2. **Stack**: OK with Spring Boot + SvelteKit + Postgres as above?
3. **Photo storage**: MinIO in the cluster, or a managed S3-compatible bucket?
4. **Admin login**: simple username/password, or an existing OIDC provider?
5. **Price source for sets**: BrickLink API (does he still have API access / a seller account?), BrickEconomy Premium, or entering values by hand?
6. **Barcode scanning**: wanted? (Needs a Brickset API key.)
7. **Offline entry**: does he enter sets where there's no signal (attic, storage unit), so that offline queueing is needed?
8. **Used-without-box discount**: should the app apply a percentage, or always use the plain used average?
9. **Public catalogue**: in selling mode, show market values, asking prices only, or both (`selling_value_display`)? Should the showcase offer `show_values` at all, or is that only for selling? Contact form, or text only? Which languages (EN only, or also NL/EL)?
10. **Loose minifigures**: are there any outside sets that need tracking?
11. **Parts file**: which file does he have (BrickLink XML, `.bsx`, or both)? Ask for a copy to build and test the parser.
12. **Currency**: EUR?
