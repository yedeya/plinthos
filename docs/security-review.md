# Security review

`AGENTS.md` §1's release gate: a security review must exist before the catalogue link is first shared, and the gate is **no open Critical or High finding**. Each later release that touches auth, the publish step, uploads or infrastructure adds a dated pass below the first.

## 2026-11-04: the printable catalogue, with each item's cover (#255)

**Summary.** No Critical or High finding; the gate still holds. One new finding, Low and accepted (F-20). The pass covers `/admin/summary` becoming a printable catalogue that lists every item after the summary (`src/app/_admin/catalogue-summary.tsx`, `src/server/export/summary.ts`, `[EXP-5]`) and the new admin route that answers an item's cover thumbnail (`src/app/admin/api/photos/covers/[itemId]/route.ts`). It was reviewed against `feat/255-print-catalogue`.

- **The item list** is built from the same `PublicCatalogueData` as before, through `readCatalogueData`: every item the catalogue would publish now, with its public fields, and an item's value only where the data holds one, which the projection gives only with market values shown (`[PUB-17]`). `[PUB-4]`'s matrix renders it under every combination of the settings and scans it for every canary in every encoding, the storage location, the overrides and the values and asking prices wherever the combination hides them included. It also checks that every item is listed and that a value appears exactly with market values.
- **The photos.** The page names an item's cover only as `/admin/api/photos/covers/{itemId}`. The item's id is public: the catalogue's own page paths name it. Neither a stored key nor one of the data's photo paths is in the HTML: the matrix asserts that every `<img>` is that route for an item with a photo, and nothing else. The route is an `adminRoute`, which the route test finds and refuses anonymously before the database (`[AUTH-3]`, `[AUTH-6]`). It calls `presignCoverThumbnail`, an `adminOperation` whose input is a zod UUID. That picks the photo the catalogue shows first (the cover, else the first in the admin's order), and answers a `302` to a presigned GET of its stored thumbnail, valid for 10 minutes like every admin photo (`[PHOTO-6]`), marked `no-store`. An item without a photo, an unknown id or one that isn't a UUID answers `404`. The thumbnail is a stored size, re-encoded on upload with no metadata (`[PHOTO-3]`), the same size the catalogue publishes.
- **Why not the snapshot's copies.** The data's photo paths are random names under which nothing is written, and the last publish's paths would need the token in the admin page, reflect the last publish rather than now, and be gone after a rotation. Redirecting to the private bucket needs no CSP change: the admin sends no CSP, and its pages already show presigned thumbnails (`[ITEM-8]`).
- **The document title** is built from the app's name and the data's time alone, with no input, and set in the browser by a client component. The page exports no `generateMetadata`, which Next.js would run outside the admin check.
- **Unchanged:** the projection, the snapshot, its writer, the token, photo copies, the public distribution and the buyer CSV. No schema change, no new resource.

| F-n | Title | Likelihood | Impact | Severity | Status |
|---|---|---|---|---|---|
| F-20 | A saved copy of the printable catalogue's HTML holds presigned photo links | Low | Low | Low | accepted |

### F-20: A saved copy of the printable catalogue's HTML holds presigned photo links

The page's HTML names only the cover route. A browser that saves the page "complete", or a network log, can still keep the redirect's presigned address for a while. That address reaches one thumbnail of the private bucket, and the signature expires 10 minutes after it was made. A printed page or a PDF holds the image itself, never the address. Accepted: the thumbnail is a re-encoded size the public catalogue publishes anyway, and the admin's item list hands out the same kind of address.

## 2026-11-03: the CSV export and the printable summary (#236)

**Summary.** No Critical or High finding; the gate still holds. Two new findings, both Low and accepted (F-18, F-19). The pass covers the first routes since the publish step that read private data for a download, the projection's second reader, and the CSV writer's injection guard (`src/server/export/`, `src/app/admin/export/`, `src/app/admin/summary/page.tsx`, `[EXP-1]` to `[EXP-5]`). It was reviewed against `feat/236-export`.

- **The routes.** `GET /admin/export/buyer` and `GET /admin/export/full` are Route Handlers built with `adminRoute`, and `/admin/summary` a page built with `adminPage`. The route test finds all three by walking `src/app/`, and refuses each with no cookie, with forged cookies and with `x-middleware-subrequest`, before the database (`[AUTH-3]`, `[AUTH-6]`). Each calls an `adminOperation` (`exportCollection`, `readCatalogueSummary`), which checks the issued `AdminContext` again and validates its input with zod: a preset is `buyer` or `full` and nothing else (`[AUTH-5]`). A download answers `Content-Disposition: attachment`, `text/csv; charset=utf-8`, `nosniff` and `Cache-Control: no-store`; its file name is built from the preset and the day alone, so no input reaches the header. The session cookie is `SameSite=Strict`, so a link from another site arrives without it and is refused; even a request that carried it would only download the file to the owner's own device, where the other site can't read it.
- **The second reader of the projection.** `readCatalogueData` (`src/server/publish/projection.ts`) runs the same `project` as `readPublication`, so the buyer CSV and the summary hold what a publish would publish now and nothing more. It takes no turn and reads and writes no token, so an export can't make a catalogue link before the first publish, wait for a publish, or hold one up. It answers the `PublicCatalogueData` alone: the photo copies, which hold the stored keys, are dropped, and what it answers is never added to `issued`, so `assertPublicProjection` and the writer refuse it (`tests/server/publish/snapshot-writer.test.ts`). The data's photo paths are random names under which nothing is written, and neither the CSV nor the summary names one. The summary names no token: the data holds none.
- **`[PUB-4]`** now exports the buyer CSV and renders the summary to a string under every combination of the settings, and scans both for every canary in every encoding: storage locations, overrides and their currencies, quotes, lot ids and unit prices, the token, and the values and asking prices wherever the combination hides them. The CSV may hold the items' market values only with them shown, and never an asking price; its value columns are there exactly with market values.
- **The full preset** is a new reader of private columns (`docs/qa/stack.md`, `## Data isolation`): every entered field of every item, the storage location and the override with its currency included, and each item's value with its source and date through `readCollectionValues`. Only the admin's download reaches it; nothing publishes or links it. It reads no parts lot and no photo. `export.downloaded` logs the preset and the row count, never a field.
- **CSV injection.** Every cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading `'`, whatever its type, before RFC 4180 quoting (OWASP's set, `src/server/export/csv.ts`, `[EXP-4]`). The free-text fields, the description, the missing parts, the name, the reference number and the storage location, are the ones an owner could paste a formula into; the set name and theme come from Rebrickable and are guarded the same way.
- **Unchanged:** the snapshot, its writer, the token, photo copies and the public distribution. No schema change, no new resource.

| F-n | Title | Likelihood | Impact | Severity | Status |
|---|---|---|---|---|---|
| F-18 | A downloaded full CSV leaves the app's protection | Low | Medium | Low | accepted |
| F-19 | The formula guard's apostrophe shows in some spreadsheet programs | Medium | Low | Low | accepted |

### F-18: A downloaded full CSV leaves the app's protection

The full preset holds every private field of every item: storage locations and the owner's own values above all. Once downloaded it sits in the device's downloads folder, and may be synced to a cloud drive or attached to an e-mail, where nothing in this app protects it. The label on `/admin` says it holds private fields, and the buyer preset is the one to hand on. Accepted: it is the owner's own record, which the owner asked for (brief #233, decision 1).

### F-19: The formula guard's apostrophe shows in some spreadsheet programs

A description or a missing-parts note that starts with `-`, such as "-2 tiles", is written as `'-2 tiles`. A spreadsheet program that opens a CSV may show the apostrophe as part of the text (recalled, not tested on each program). That is the guard's known cost: without it the cell would run as a formula. Accepted.

## 2026-11-03: the parts valued from BrickLink first, in the catalogue's parts subtotal and download (#229)

**Summary.** No Critical or High finding; the gate still holds. No new finding. The pass covers the publish step's change: the loose parts' value and the parts download's per-lot unit price now come from each lot's value by `[VAL-6]`, BrickLink's average first and the file's price as the fallback (`src/server/valuation/values.ts`, `src/server/publish/projection.ts`, `[PUB-20]`). It was reviewed against `feat/229-parts-values`, on top of #228.

- **One reader still.** The projection reads the values only through `readCollectionValues`, as before, and only when the settings show something. It now answers each lot's value by the lot's id as well (`partsLots`). With market values shown, that reads `part_price_quote`'s average, currency and fetched-at, joined in memory to the lots; nothing else of the new tables, and never `price_refresh_run` or `bricklink_call_day`.
- **The file's price is no longer read by the publish.** `readDownloadLots` (`src/server/parts/lots.ts`) answers a lot's five public fields and its private id, and never a unit price or the file's currency. A lot's price in the download is its `[VAL-6]` value divided by its quantity, to three decimals, only with market values in selling mode; a lot with no value has no price. The id is only a key for that join: no published field is built from it, and `tests/server/publish/values.test.ts` checks that it is in no file.
- **No date per lot.** A BrickLink value's date is shown on `/admin/parts` alone; the download carries no per-lot date, so it says nothing about when each quote was fetched.
- **One currency.** A lot is valued only in the deployment's currency: a BrickLink quote in another currency, or a file price in another currency, values nothing. So the parts subtotal and every lot price are in `valueCurrency`.
- **`[PUB-4]`.** The canary reader answers a canary value for the canary lot. Its unit price is a needle shown only in selling mode with market values. The file's own unit price is now refused under every combination, and the file's currency changes no byte, so the matrix comes to five effects, not seven.
- **Unchanged:** the settings' effects, escaping, the CSV and XML writers, the token, photo copies and the writer's path check. `SNAPSHOT_FORMAT` stays 4, because the contract's shape is unchanged: `parts.value` and a lot's optional `price` mean the `[VAL-6]` value now.

## 2026-11-03: the price refresh as a background job (#228)

**Summary.** No Critical or High finding; the gate still holds. Two new findings, both Info and accepted (F-16, F-17). The pass covers the first function besides the admin's server: the price refresh's background job (`infra/prices.ts`, `src/server/valuation/worker.ts`, `src/server/valuation/job.ts`, `[VAL-9]`, `[VAL-10]`), its invocation path, its permissions, its input and its lease, and the three new tables. It was reviewed against `feat/228-price-job`.

- **The invocation path.** The function has no URL, no schedule, no event source and no resource policy of its own, so nothing outside the account can invoke it. Inside the account, two principals may: the admin's server, which `infra/stack.ts` links to the function (SST's link grants `lambda:InvokeFunction` on the function's ARN alone), and the function itself, for the rest of a run. A principal with broad Lambda rights in the account, such as the deploy role, could invoke it too; that is the account's trust boundary, as for every resource here (F-7). The admin's server invokes it only from `startPriceRefresh`, an `adminOperation`, so only the signed-in admin can start a run (`[AUTH-3]`, `[AUTH-5]`).
- **The IAM scope.** The function's role holds the Data API and the database secret through its link to the database, the four BrickLink secrets through theirs, and one statement of its own: `lambda:InvokeFunction` on `arn:<partition>:lambda:<region>:<account>:function:<its own name>`. A function can't link itself, so the name is fixed in `infra/prices.ts` and the ARN built from it; `tests/infra/prices.test.ts` holds the statement to exactly that. No session secret, bucket, table or other function is reachable. No reserved concurrency is set, so a new account's limit of 10 is untouched.
- **The input.** The event must be `{ runId }` and nothing else, which zod checks with a strict object and a UUID; anything else is refused before the database is reached and logged as `price.refresh.failed` with `invalid-input`, never the event itself. The run's row says what to do, its scope and whether to ask for every price, so an event can't widen a run, choose an item or reach another table. An id that names no running run does nothing.
- **The lease.** A partial unique index allows one `running` run, so two presses can't start two runs however they race. A running run whose heartbeat is older than 20 minutes is ended as `stalled` by whoever looks next, so a crashed job can't hold the lease. One invocation at a time works on a run: it must claim the run's step (`step_until`, held up to the function's 15-minute timeout) before it asks for anything, and every request first checks, in the same write as the heartbeat, that the run still runs and the owner has not asked it to stop. So a continuation Lambda delivers twice works once, and one delivered after its run ended does nothing (`tests/server/valuation/job.test.ts`). `retries: 0` keeps Lambda from running a failed step again.
- **The reads are paged.** Every read the job makes of the lots' keys and of the stored quotes goes in pages of `LOT_PAGE` rows over the table's unique key, so no Data API answer passes its 1 MB cap at the import's 50,000 lots, and no row is skipped or repeated between pages.
- **BrickLink's daily limit.** Each request, retries included, is counted in one atomic upsert before it is sent, which refuses past 4,500 calls in the UTC day; a refused request is never sent (`[VAL-10]`). Concurrent steps can't overrun the cap, because the count and the cap are one statement.
- **Secrets and logs.** The OAuth signing is unchanged, and the colour is signed with the rest of the query. The job's logger scrubs the four BrickLink secrets as the admin's does. No line carries a secret, a signature, a URL or an ARN: an invocation's error is not logged, because an SDK error can name the function's ARN, which holds the account id, and a step's error is logged by its kind alone.
- **The new tables** are private, every column (`[PUB-3]`): `part_price_quote`, `price_refresh_run` and `bricklink_call_day`. The publish step reads none of them, and `[PUB-4]`'s canaries fill them; their fixed-value columns are named in `FIXED_PRIVATE` with their reasons.

| F-n | Title | Likelihood | Impact | Severity | Status |
|---|---|---|---|---|---|
| F-16 | **Refresh prices** fails until the migration step has run | Low | Low | Info | accepted |
| F-17 | A continuation Lambda holds back for over 20 minutes ends its run as stalled | Low | Low | Info | accepted |

### F-16: **Refresh prices** fails until the migration step has run

`startPriceRefresh` writes `price_refresh_run`, which this change's migration creates. Between the end of `sst deploy` and the end of the migration step, a press of **Refresh prices** fails on the server, and the page says so; nothing else reads the new tables, and the old prices are kept. Only the owner can press it. The migration only adds tables, so it may also run before the deploy, as #204's did (`docs/qa/stack.md`, "Expand first"). Accepted.

### F-17: A continuation Lambda holds back for over 20 minutes ends its run as stalled

Lambda queues an asynchronous invocation and, when the function is throttled, retries it for up to six hours. A continuation held back longer than 20 minutes lets the run's heartbeat go stale, so the next look ends it as `stalled` and the owner presses again; the late continuation then finds its run ended and does nothing. It fails closed: no run outlives its row, and no price is lost. With no reserved concurrency and one run at a time, throttling needs the account's whole concurrency to be in use. Accepted.

## 2026-11-03: values and selling mode in the catalogue (#211)

**Summary.** No Critical or High finding; the gate still holds. Two new findings, both Info and accepted (F-14, F-15). The pass covers the publish step's first change that publishes a private field: market values and asking prices, under the settings ([PUB-17] to [PUB-20]), and the parts download (#5). It was reviewed against `feat/211-selling` with #210's `readCollectionValues` merged in; the `[PUB-4]` matrix injects its own canary values.

- **What decides.** One function, `shownBy` in `src/server/publish/projection.ts`, turns the three settings into what is shown: market values, asking prices, selling mode. With selling mode off, Show values alone decides and no asking price is shown; with it on, the display alone decides and Show values is ignored; a display not yet set is `ASKING`. The settings themselves are never published.
- **Hidden means not read, where it can.** `readCollectionValues` is called only when something is shown, and its items and parts are used only with market values. The asking prices are selected only when they are shown. A lot's unit price and the file's currency are selected only with market values in selling mode (`src/server/parts/lots.ts`). So an asking price stored while selling mode is off never enters the publish.
- **Hidden means absent.** A hidden field is left out of `catalogue.json`, never `null` or zero (`src/server/publish/catalogue-data.ts`), so a snapshot that shows nothing has a format-3 snapshot's keys and says nothing about what is stored. Totals are the sums of the values the snapshot holds, per `segmentOf`'s segments, so no aggregate says more than the items. The value sort exists only when a card carries a value.
- **One currency.** Only a value in the deployment's currency is published, and a lot's price only when the file's currency is that one or unnamed; a total never adds two currencies. A currency that is not three capital letters fails the publish, so nothing un-validated reaches a page's formatter.
- **The parts download** (#5) is generated from the stored lots, which hold no remark ([PARTS-1]): item type, number, colour, condition and quantity, and the unit price only with market values. The five lot columns are now public in `[PUB-3]`'s registry; `unit_price` stays private. XML values are escaped, characters XML can't hold are dropped, and a CSV cell a spreadsheet would read as a formula starts with an apostrophe. The XML reads back through the import's own parser as the same lots.
- **`[PUB-4]`** now asserts both sides under every combination: every asking price, injected value, the quote's instant, the unit price and every other private column is a canary refused in every file unless the combination shows it, and each shown one must sit where the contract puts it. Combinations with the same effect must write the same bytes. `parts.csv` and `parts.xml` are scanned with every other file. The JSON key check covers every new key, and none takes a private column's name (`valueCurrency`, not `currency`).
- **Unchanged:** escaping, the CSP, `noindex`, relative links, the token, photo copies and the writer's path check, which takes the new files as plain paths.

| F-n | Title | Likelihood | Impact | Severity | Status |
|---|---|---|---|---|---|
| F-14 | A value’s "as of" day shows when prices were last refreshed, and lets a visitor infer which values are overrides | Low | Low | Info | accepted |
| F-15 | A publish by code deployed before its migration fails | Low | Low | Info | accepted |

### F-14: A value’s "as of" day shows when prices were last refreshed, and lets a visitor infer which values are overrides

With market values shown, each item's value carries the day of its quote, as `[PUB-17]` requires. That reveals the day, never the time, of the owner's last **Refresh prices** for the item. The owner's own estimate is dated by the publish's day, so the catalogue never labels a value as overridden. It can be inferred, though: every page's footer shows the publish day, so a value dated that day is an override or a quote refreshed that day, and across two publishes an override's date moves while a quote's stays. So a visitor can tell, roughly, which values are the owner's own estimates, never by how much they differ from BrickLink's. Accepted: the date is what makes an estimate honest, the day is coarse, and an override is the owner's own published estimate anyway.

### F-15: A publish by code deployed before its migration fails

The projection reads the four new asking-price columns and the display's check. Code deployed before this change's migration is applied would fail its publish, which keeps the previous snapshot (`[OPS-6]`): it fails closed, publishing nothing. The migration is additive, so it can run before the deploy, as #204's did (`docs/qa/stack.md`, "Expand first"). Accepted.

## 2026-11-02: streaming and the loading screen (#203)

**Summary.** No new finding; the gate still holds. The pass covers two changes. The admin's server function now streams (`open-next.config.ts`, `[PLAT-16]`). `src/app/admin/loading.tsx` is the first segment file under `/admin` not built with `adminPage`.

- **The loading screen holds no data.** It imports only the message file and reads no request, cookie, environment, storage or network. It renders the same markup for anonymous, forged and signed-in requests, without a database call. `tests/app/admin-routes.test.ts` enforces each of these through `dataFreeProblems`, and no other kind of segment file may join `DATA_FREE_SEGMENTS` (`docs/qa/stack.md`, `[AUTH-4]`). Every page it stands in for still runs `adminPage`'s check before it reads anything.
- **What streaming changes for an anonymous request.** A page under `/admin` sends the loading screen before its check has run. A refused request then ends in a client-side redirect to `/login` with status `200`, where it used to get a `307`. The response carries the static loading markup and the redirect, nothing else, and the check still runs before the database (`[AUTH-6]`). Route Handlers, the sign-in and the logout are unchanged: they answer as a whole.
- **The service worker** never caches a response under `/admin` or a navigation, so it can't keep a streamed page or its loading screen (`[SYNC-6]`).
- **Infrastructure.** The function URL's invoke mode becomes `RESPONSE_STREAM`, which is configuration of the same function. Nothing else changes: no new resource, the same distribution and origin, the same `protection`, and F-8 stands as it was.

## 2026-11-02: the first review (#164)

**Summary.** No finding is graded Critical or High, so the gate holds and the catalogue link may be shared.
Two findings are Medium:

- **F-1, fixed (#187):** deleting a photo or a set used to leave it in the public catalogue until the next publish, and the admin didn't say so. As the Owner chose, a delete now republishes a published catalogue, once per sync batch and after the admin's own Delete (`[PUB-16]`). When that republish fails, the admin's own Delete on `/admin/photos` and `/admin/parts` says so. On the sync path, which is how a set is deleted, the answer carries `catalogue: 'stale'`, and the device's header tells the admin to press Publish (#192).
- **F-7, accepted (#74):** the deploy job runs dependency install scripts where they can assume the broad deploy role. The Owner accepted it under the decision recorded in #74.

Five are Low, and six are Info. The design `AGENTS.md` §1 sets out holds up in the code, not only in the docs:

- the public snapshot is built from one projection that names its columns;
- uploads are re-encoded from a quarantine nothing serves;
- the token has 256 bits;
- sessions are server-side, and cookies are signed and refused before the database;
- every admin entry point goes through one of three wrappers that the route test enumerates.

**Commit reviewed.** `455826bec48df69349d414a7578fcf344e62aeaf` (`main`, "feat: the catalogue's pages and the settings page (#163) (#171)"). Open PR #184 ("publish the parts summary and copies of the parts lot's overview photos", head `dd2509b`) was reviewed as a diff on top of it. Findings that come from it are marked **[PR #184]**.

**Method.** Reading the code under `src/`, `infra/`, `sst.config.ts`, `next.config.ts`, `open-next.config.ts` and `.github/`, and the tests that hold the security properties. The suites for auth, the admin routes, publish, photos, the parts parser, the snapshot and photo infrastructure and the service worker were run against a local PostgreSQL: 20 files, 211 tests, all passing. `npm audit` was run, with and without `--omit=dev`. Nothing was tested against the deployed stack.

### Scope

- **Admin auth:** `src/server/auth/` (login, scrypt hash, cookie, sessions, revocation, rate limit, the CloudFront origin header, the same-origin check), `src/app/auth/login/route.ts`, `src/app/admin/logout/route.ts`, every admin page, Route Handler and Server Action under `src/app/`, and `tests/app/admin-routes.test.ts`.
- **Offline sync:** `src/server/sync/` (the envelope, the registry, idempotency through `applied_mutation`, version conflicts, the per-batch caps), `src/app/admin/api/sync/route.ts`.
- **Uploads:** the photo presign route, the POST policy, `guardedStorage`, quarantine, the sharp re-encode and its metadata check, the trash (`src/server/photos/`). The parts file's presign route, the `imports/` prefix, the size cap and the XML parser's DOCTYPE and entity handling (`src/server/parts/`).
- **Publish:** `src/server/publish/` (the projection, token generation, the lease, rotation and cleanup, the photo copies, the page renderers' escaping, CSP, `noindex`, `catalogue.json`), `src/db/schema/classification.ts`, `tests/server/publish/`.
- **Infrastructure:**
  - `infra/` (bucket policies and public access blocks, the snapshot distribution and its headers, the IAM links on the server function, the Lambda URL, CORS, lifecycle rules, the database's network);
  - secrets handling (`infra/config.ts`, `src/server/linked.ts`);
  - log redaction (`src/server/logger.ts`);
  - the deploy lane (`.github/workflows/deploy.yml`, `.github/actions/deploy/`), and the `production` environment's protection rules (read through the GitHub API).
- **Device:** the service worker (`src/app/sw.js/`), the IndexedDB queue and sign-out (`src/app/_offline/`).
- **Dependencies:** `npm audit`, and `docs/dependency-audit.md`.

### Grading

Likelihood and impact are each Low, Medium or High. Severity is their product:

| | Impact Low | Impact Medium | Impact High |
|---|---|---|---|
| **Likelihood High** | Medium | High | Critical |
| **Likelihood Medium** | Low | Medium | High |
| **Likelihood Low** | Info | Low | Medium |

The likelihood assumes the threat this deployment faces: anyone on the internet who finds the admin's address, and anyone who has been given the catalogue link. Neither is a targeted, resourced attacker.

### Findings

| F-n | Title | Likelihood | Impact | Severity | Status |
|---|---|---|---|---|---|
| F-1 | Deleted photos and sets stay in the public catalogue until the next publish, unannounced | Medium | Medium | Medium | fixed (#187: a delete republishes a published catalogue, `[PUB-16]`) |
| F-2 | The login's per-address limit counts each IPv6 address apart, so the total limit can be used to lock the owner out | Low | Medium | Low | open |
| F-3 | The admin sends no CSP, HSTS, frame or referrer headers | Low | Medium | Low | open |
| F-4 | Free-text item fields are published, and the form doesn't say so | Low | Medium | Low | open |
| F-5 | The origin header's value is readable by anyone who can read the AWS account | Low | Medium | Low | accepted |
| F-6 | The offline queue keeps private data on the device after the session ends | Low | Medium | Low | accepted |
| F-7 | Dependency install scripts in the deploy job can assume the broad deploy role | Low | High | Medium | accepted (#74) |
| F-8 | The server function's Lambda URL is reachable without CloudFront | Low | Low | Info | accepted |
| F-9 | Visitors' browsers load the stock images from Rebrickable | Low | Low | Info | accepted |
| F-10 | After a rotation whose cleanup fails, the old link can keep working for up to a day | Low | Low | Info | accepted |
| F-11 | No way to end one session, or every session, short of changing a credential | Low | Low | Info | accepted |
| F-12 | Moderate advisories in development and build tooling | Low | Low | Info | accepted |
| F-13 | The admin's address is printed in deploy output | Low | Low | Info | accepted |

**The gate.** Counted on the Severity and Status cells, `grep -c -E '(Critical|High) . open' docs/security-review.md` prints 0: no Critical or High finding is open. The brief's measure was corrected to that command (the Owner's decision, 2026-11-02). Its earlier line-based form also matched F-7's row, whose *Impact* cell reads High. The open findings are F-2, F-3 and F-4 (all Low). F-1 (Medium) is fixed by #187 and #192.

### F-1: Deleted photos and sets stay in the public catalogue until the next publish, unannounced

**Severity Medium (likelihood Medium × impact Medium). Fixed, #187, for items, their photos and the parts lot's overview photos ([PR #184] had extended it to the latter). On the sync path, a failed republish is shown on the device by #192.**

**Evidence.**
- `deletePhoto` (`src/server/photos/photos.ts`) deletes the row and moves the private stored sizes to `trash/`. `deleteItem` (`src/server/items/items.ts`) deletes the item and its photos the same way. Neither touches the snapshot bucket.
- The public copies under `c/{token}/p/{random}.webp` (`[PUB-13]`), the item's page `c/{token}/s/{id}/` and its entry in `catalogue.json` are removed only by the next publish's `removeStale` (`src/server/publish/snapshot.ts`).
- The admin gives no hint of this. The set's confirmation reads "Delete this set and its photos? This cannot be undone once it syncs." (`src/app/messages/en.ts`), and a photo's Delete button has no confirmation at all. The texts' Save, by contrast, says "Publish to show the new texts in the catalogue."

**Attack, or exposure.** The owner deletes a photo because it shows something they didn't mean to share: a face, a room, a delivery label with an address. They believe it is gone. Everyone who has the catalogue link can still open it, and download it, until the owner happens to publish again. That could be weeks. With PR #184, the same holds for the parts lot's overview photos.

**Fix.** After any deletion that affects published content, the admin says that the catalogue still shows it and offers to publish. Alternatively, the deletion removes the public copies itself, which needs a record of each photo's public paths. The confirmations say what happens. Covered by a test (#187). **The Owner chose the second option (2026-11-02):** a deletion that affects published content republishes the catalogue automatically, so the public copies are removed by the publish's own cleanup (#187).

### F-2: The login's per-address limit counts each IPv6 address apart

**Severity Low (likelihood Low × impact Medium). Open.**

**Evidence.**
- The admin's viewer-request function sets `x-plinthos-viewer-address` to `event.viewer.ip` (`infra/admin.ts`). `countLoginAttempt` keys the per-address count by that exact string (`addressKey`, `src/server/auth/rate-limit.ts`).
- One IPv6 host usually controls a whole /64, so it can present as many addresses as it likes, each with its own 10 attempts.
- The total limit (100 in 15 minutes) still caps guessing at about 9,600 attempts a day. Against a password `scripts/hash-password.ts` accepts, hashed with scrypt N=2^17, that is not a practical brute force.

**Attack.** Someone who finds the admin's address (F-13) sends 100 wrong logins every 15 minutes from addresses in one /64, or from a handful of IPv4 addresses. The total limit then refuses every sign-in, the owner's included, for as long as they keep at it. Existing sessions keep working (idle 7 days, absolute 30), and the public catalogue doesn't depend on the admin, so the impact is the owner being unable to sign in on a new device, or after a session ends.

**Fix.** Count an IPv6 address by its /64 prefix (and an IPv4 address as it is) before hashing it. Optionally log `auth.login.rate_limited` with `scope: 'total'` as a signal, if the owner wants to know about a lockout. That signal decision belongs to `docs/observability.md`. Not filed as an issue: it is Low.

### F-3: The admin sends no CSP, HSTS, frame or referrer headers

**Severity Low (likelihood Low × impact Medium). Open.**

**Evidence.** `next.config.ts` adds only `X-Robots-Tag: noindex`. The admin's distribution (`sst.aws.Nextjs`, `infra/admin.ts`) gets no response-headers policy, unlike the snapshot's (`infra/snapshot.ts`). So the admin's pages carry no `Content-Security-Policy`, no `Strict-Transport-Security`, no `X-Frame-Options` or `frame-ancestors`, and no explicit `Referrer-Policy`.

**Attack.** There is no known injection to exploit: React escapes everything the admin renders, and `dangerouslySetInnerHTML` appears nowhere under `src/`. So this is defence in depth that's missing.

- **Framing:** the cookie is `SameSite=Strict`, so a cross-site frame loads the admin signed out. Clickjacking of a signed-in action is already blocked.
- **HSTS:** without it, the first plain-`http://` visit can be intercepted on a hostile network. The `__Host-` cookie is `Secure`, so it never travels over plain HTTP, but a stripped login page could capture the password.
- **CSP:** a future injection bug would have nothing to contain it.

**Fix.** Give the admin's distribution a response-headers policy, or set the headers in `next.config.ts`:

- HSTS;
- `X-Frame-Options: DENY`, or `frame-ancestors 'none'`;
- `Referrer-Policy: same-origin`;
- `X-Content-Type-Options: nosniff`;
- a CSP compatible with Next.js's inline bootstrap: nonces, or at least `frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`.

Not filed: it is Low.

### F-4: Free-text item fields are published, and the form doesn't say so

**Severity Low (likelihood Low × impact Medium). Open.**

**Evidence.**
- `description` and `missing_notes` are classified public (`src/db/schema/classification.ts`, as `HANDOVER.md` §4.1 asks). They go into each set page and into `catalogue.json` (`src/server/publish/projection.ts`).
- The entry form marks Storage "🔒 Private, never published" (`src/app/messages/en.ts`) but gives Description and "What's missing" no hint at all.
- Every photo attached to an item is published too.

**Exposure.** An owner who types a private remark into Description, such as what they paid, where it came from, or a buyer's name, publishes it at the next publish. Nothing in the code is wrong. The classification is deliberate, but the form invites the mistake.

**Fix.** Label Description and "What's missing" as shown to visitors, as Storage is labelled private, and say on the photo picker that photos are published. Not filed: it is Low.

### F-5: The origin header's value is readable by anyone who can read the AWS account

**Severity Low (likelihood Low × impact Medium). Accepted.**

**Evidence.** The `x-plinthos-origin` value is an HMAC of `SessionSecret` (`src/server/auth/via-cloudfront.ts`). It is written into the CloudFront Function's code and SST's state as plain text (`infra/admin.ts`, `docs/deploy.md`). Anyone with `cloudfront:DescribeFunction` in the account, or read access to SST's state bucket, can read it. With it, a caller of the Lambda URL could pass the login's CloudFront check and pick the address the rate limiter counts it under. Only the total limit would then hold.

**Why accepted.** It reveals neither `SessionSecret` nor any cookie key. Whoever can read the account's CloudFront functions or SST state already has far more than a way round a rate limit. Rotating `SessionSecret` rotates it. The trade-off is documented in `docs/deploy.md` ("Why the URL has no IAM auth").

### F-6: The offline queue keeps private data on the device after the session ends

**Severity Low (likelihood Low × impact Medium). Accepted.**

**Evidence.**
- The IndexedDB queue (`src/app/_offline/queue.ts`) holds queued mutations in plain text: storage locations and the resized photos' bytes included.
- It deliberately outlives a session (brief #6, §1), because a stretch offline can outlast the idle lifetime. Only an explicit sign-out clears it, together with every cache (`src/app/_offline/sign-out.ts`).
- The service worker caches only the data-free `/offline` shell and static assets, each fetched with `credentials: 'omit'`, and never anything under `/admin` (`src/app/sw.js/worker.ts`). The cache is not the exposure. The queue is.

**Exposure.** Someone who gets the owner's unlocked phone, after the session has expired but before it was synced or signed out, can read the queued changes in the browser's storage.

**Why accepted.** It is the Owner's decision of brief #6: offline entry would otherwise lose work. The data is the owner's own, on the owner's own device, and the photos were already resized and stripped of EXIF by the canvas re-encode. Sign-out clears everything, after a warning.

### F-7: Dependency install scripts in the deploy job can assume the broad deploy role

**Severity Medium (likelihood Low × impact High). Accepted by the Owner on 2026-11-02, under the decision recorded in #74.**

**Evidence.**
- The deploy job (`.github/actions/deploy/action.yml`) runs `npm ci` with lifecycle scripts enabled, in a job with `id-token: write`. The action's own comment notes that an install script could mint the OIDC token and assume the role, and that `sst deploy` and the migration run dependency code with the credential in any case.
- `docs/deploy.md` calls the deploy role broad: in effect, the whole member account.
- Mitigations in place: the lockfile pins versions and integrity hashes; the `production` environment requires a reviewer and has a branch policy (checked through the GitHub API); and the lane doesn't deploy yet (kanon#1555), so deploys run from the owner's machine. That path has the same exposure with whatever credential the owner uses.

**Attack.** A dependency, direct or transitive, publishes a malicious version, and a Dependabot PR that updates the lockfile is merged. At the next deploy its install script assumes the role. It can then:

- read the SST secrets, including the password hash and `SessionSecret`, so it can forge session cookies;
- read and change the database through the Data API, and the photos;
- run up cost in the account. The budget alerts, but doesn't stop anything.

**Decision: accepted (#74).** The Owner decided on 2026-11-02, in #74, that the lockfile pin is enough for now:
- a malicious version must first be committed to `package-lock.json` through a reviewed pull request;
- every deploy waits for the Owner's approval on the `production` environment;
- the member account holds nothing but Plinthos;
- `--ignore-scripts` alone wouldn't close the path, because `sst deploy` itself runs dependency code with the credential.

Any of these reopens it: the account holding anything beyond Plinthos, a second person able to approve production deploys, or a supply-chain incident in a dependency this project uses. #188 is closed as covered by #74.

### F-8: The server function's Lambda URL is reachable without CloudFront

**Severity Info (likelihood Low × impact Low). Accepted.**

**Evidence.** SST's `protection` stays `none` (`infra/admin.ts`, `docs/deploy.md`), so the function URL answers anyone who learns it, with every header the caller chooses, `x-forwarded-host` included.

- **The login** refuses such a request before anything else, because it lacks the origin header (`cameThroughCloudFront`, [AUTH-14]).
- **Every other admin route** still requires a valid signed session cookie, checked before the database (`authenticate`, `src/server/auth/sessions.ts`).
- **The same-origin check** only matters for browsers, which can't send a forged `x-forwarded-host` to the URL with the owner's cookie: the cookie is host-only to the CloudFront domain.

**Why accepted.** Going round CloudFront gains nothing that the cookie doesn't already gate. An unauthenticated request never reaches Aurora, so it can't keep it awake. Invocations cost the same through either path, and the budget alert covers cost. Closing the URL needs OAC with edge signing, which was turned down for its cost and complexity (`docs/deploy.md`).

### F-9: Visitors' browsers load the stock images from Rebrickable

**Severity Info (likelihood Low × impact Low). Accepted.**

**Evidence.** A set's stock image is Rebrickable's `set_img_url`, kept only when it is `https://` (`stockImage` in `projection.ts`, `httpsUrl` in `pages/html.ts`). The landing page shows it by default (`[PUB-11]`). The pages' CSP therefore allows `img-src 'self' https:` (`pages/layout.ts`).

**Exposure.** A visitor's address and user agent reach Rebrickable's CDN. The token doesn't: the pages send `no-referrer` by meta tag, by the snapshot distribution's header and by `referrerpolicy` on each external image. A tampered `set_img_url` could point at any HTTPS host, but it can only ever be an image source, never markup or script.

**Why accepted.** It is the design of `[PUB-11]` and costs nothing. Copying the stock images into the snapshot would close it if the owner ever wants that.

### F-10: After a rotation whose cleanup fails, the old link can keep working for up to a day

**Severity Info (likelihood Low × impact Low). Accepted.**

**Evidence.** A rotation writes the whole snapshot under the new token, stores the token, and only then deletes the old token's objects and invalidates `/c/{old}/*` (`src/server/publish/publish.ts`). If that tidy-up fails, the rotation still succeeds, and the admin reports `oldRemoved: false`, which the settings page words as "it may keep working from the cache for up to a day. Publish again to finish removing it." CloudFront keeps a file for up to a day (`s-maxage=86400`, `SNAPSHOT_CACHE_CONTROL`).

**Why accepted.** The owner is told and given the remedy. The next publish's `removeStale` deletes every object under `c/` that its snapshot doesn't hold, so nothing is left in the bucket indefinitely.

### F-11: No way to end one session, or every session, short of changing a credential

**Severity Info (likelihood Low × impact Low). Accepted.**

**Evidence.** Logout deletes the session's own row (`endSession`). Changing `AdminPasswordHash`, `AdminUsername` or `SessionSecret` ends every session: the cookie key is derived from all three, and the migration step deletes the rows of any other key (`revokeSessionsSignedWithAnotherKey`, [AUTH-10]). There is no admin page that lists sessions or ends the others.

**Why accepted.** One owner, and a credential change is the documented way to end every session, for example after a lost phone (`docs/deploy.md`). A "sign out everywhere" button would be a small product follow-up, if wanted.

### F-12: Moderate advisories in development and build tooling

**Severity Info (likelihood Low × impact Low). Accepted.**

**Evidence.**
- `npm audit --omit=dev` reports 0 vulnerabilities.
- `npm audit` reports 18 moderate and no high or critical. They come from three advisories: `esbuild` under `drizzle-kit`, and `minimatch` and `glob` under `eslint`, `typescript-eslint` and `@opennextjs/aws`'s minifier.
- `docs/dependency-audit.md` records each with why it isn't reached, and `tests/tooling/dependency-advisories.test.ts` holds the resolved high.

**Why accepted.** None is installed in the deployed function, and none takes input from a visitor. F-7 covers the deploy job's general exposure to dependency code.

### F-13: The admin's address is printed in deploy output

**Severity Info (likelihood Low × impact Low). Accepted.**

**Evidence.** `defineStack` returns `adminUrl` and `catalogueHost` as outputs (`infra/stack.ts`). They are printed at the end of every `sst deploy`. Once the deploy lane runs, they appear in this public repository's Actions logs. The catalogue's host is not a capability: the token is, and it is never printed.

**Why accepted.** The admin's address is not meant to be secret. Security rests on the login, the rate limit and the session check, not on obscurity. It does make F-2 easier to reach, which is one reason F-2 stays open.

### Checked and found sound

What was looked for and not found, so a later pass knows it was examined:

- **No first-visitor setup.** The admin account comes only from SST secrets (`src/server/auth/config.ts`). No route creates, claims or resets one.
- **Login.**
  - scrypt with N=2^17, r=8, p=1, with the stored parameters bounded, so a hash can't request unbounded memory.
  - Constant-time comparison of both username and password. scrypt runs even when the username is wrong.
  - Rate limited before the password is checked, in DynamoDB, so Aurora is never woken. It fails closed when the table is unreachable.
  - Same-origin and CloudFront checks first.
- **Session cookie.**
  - `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`.
  - A 256-bit id, stored only as its SHA-256.
  - An HMAC signature under a key derived from all three credentials, checked before the database.
  - Idle and absolute lifetimes checked on the server.
  - A fresh id at every sign-in, so session fixation isn't possible.
- **Every admin entry point is wrapped.**
  - Every page and Route Handler under `src/app/admin/` uses `adminPage` or `adminRoute`.
  - `src/app/admin/actions.ts`, the only `'use server'` file, wraps every export in `adminAction`.
  - Service functions re-check the `AdminContext` through a `WeakSet` of issued contexts (`adminOperation`).
  - The public allow-list is `/login`, `/auth/login`, `/health/live`, `/offline`, `/sw.js` and the manifest, and none of them reads data.
- **CSRF.** Every state-changing request needs a matching `Origin` and a same-origin `Sec-Fetch-Site`, Server Actions included. A cross-site `GET` carries no cookie under `SameSite=Strict`.
- **Offline sync.**
  - Each mutation is validated with its own service function's zod schema, by name from a closed registry.
  - The applied-mutation record is claimed first in the mutation's own transaction: a replay with the same payload is `already-applied`, and one with a different payload is a conflict.
  - Versioned records are locked and compared, and racing creates are answered as conflicts, never overwrites.
  - The batch caps (100 mutations, 5 photos, 40 seconds) bound the work one request can cause.
  - Logs carry ids and names, never payloads.
- **Photos.**
  - Keys are made by the server from 256 random bits, and `guardedStorage` refuses any other shape.
  - The POST policy pins the key, the size range and the content type, and expires in 10 minutes. CORS allows only the admin's origin to POST.
  - Quarantine is never presigned for reading or served, expires after a day, and is deleted after every outcome.
  - Only JPEG is decoded, with a pixel cap. Each stored size is re-encoded as WebP and re-read to prove that it carries no EXIF, XMP, IPTC or ICC data.
  - The GPS test (`[PHOTO-4]`) passes.
  - The trash is write-only to the function and expires after 30 days.
- **Parts file.**
  - The upload is presigned into `imports/` under a server-made key, capped in size, then read and deleted whatever the outcome.
  - Any `<!ENTITY`, and any DOCTYPE other than the bare legacy ones, is refused before parsing. `fast-xml-parser` runs with entity processing off, and the XXE fixture's canary file is never read.
  - Remarks, comments and every other unkept field are never read.
- **Publish.**
  - One projection that names its columns.
  - A classification registry that a test holds complete. The canary test scans every file of a snapshot, in several encodings, under every combination of the selling settings. With PR #184 that includes the parts lots' unit prices, the total value, the currency and the lot fields.
  - The token: 256 bits from `randomBytes`, checked for shape before it becomes a key, and scrubbed from error logs.
  - Public photos are copies under fresh 256-bit paths, with `MetadataDirective: REPLACE`. Private keys appear in no file.
- **Pages.**
  - Every interpolation is HTML-escaped by the `html` tag. URLs are restricted to `https:` or a plain relative path.
  - A strict CSP with no inline script.
  - `noindex` both as a meta tag and as a header.
  - The catalogue script uses no `innerHTML` and makes no network call.
- **The snapshot distribution.**
  - S3 is its only origin, through OAC, limited to `c/*`. There is no `ListBucket`, so an unknown token gets a 403, never a listing.
  - It sends `X-Robots-Tag`, `no-referrer`, `nosniff`, `X-Frame-Options: DENY` and HSTS.
  - It allows only `GET` and `HEAD`.
- **Buckets and IAM.**
  - Both buckets block every kind of public access and refuse requests that don't use TLS.
  - The function's S3 permissions are limited to the prefixes it uses, and `CreateInvalidation` to the snapshot's own distribution.
  - The database has no network path at all (no ingress, no egress, no gateway) and is reached only through the Data API.
- **Secrets and logs.** Secrets live only in SST secrets and are never logged. The logger redacts secret-named keys at any depth, the Rebrickable key's value included. Drizzle errors that would carry a token as a parameter are replaced before logging.
- **The deploy environment.** `production` requires a reviewer and has a branch policy. The deploy role trusts only that environment's OIDC subject (`docs/deploy.md`).

### Not examined

- **The deployed stack itself.** No request was made to the live admin or catalogue, and nothing was checked in the AWS account. The following are taken from the code and SST's documented behaviour, not observed:
  - that S3 enforces the POST policy;
  - that CloudFront overwrites the viewer's `x-plinthos-viewer-address` and `x-forwarded-host`;
  - that SST's server function and image optimiser get no permissions beyond SST's defaults;
  - that the Lambda URL's CORS and auth settings are as described.

  The deploy rehearsal's measurements (#23, and #123 for the two deferred ones) cover part of this.
- **SST's and OpenNext's own generated resources:** the asset bucket, the revalidation queue and table, the image-optimisation function and the cache behaviours. They were not read, because `.sst/platform` is not installed in the checkout. `next/image` isn't used, and `next.config.ts` allows no remote images.
- **Next.js, React, sharp/libvips and fast-xml-parser internals.** Only `npm audit` was consulted. sharp and the XML parser handle content only the signed-in admin can upload.
- **Kanon's reusable workflows** (`yedeya-labs/kanon`, pinned at v0.42.0), which the agent, release and deploy workflows call. Only this repository's callers and composite actions were read, not what the reusable workflows do with their permissions and secrets.
- **The admin UI's client components** beyond the offline queue, the service worker and sign-out. They were checked only for `dangerouslySetInnerHTML` and storage APIs.
- **The Rebrickable client's** rate limiting and backoff were not re-reviewed for security, only its URL encoding.
- **Physical, device and account-level security:** the owner's phone, the AWS root account, MFA on the owner's AWS and GitHub accounts.
