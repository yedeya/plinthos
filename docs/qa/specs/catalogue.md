# Set catalogue

How the admin finds a LEGO set and fills in its details from the Rebrickable catalogue (`HANDOVER.md` §4.1). Seeded by the set-entry project (#124). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `CAT`

## Lookup

- `[CAT-1]` `[seed]` The admin can search sets by set number or by name through an admin route that refuses an anonymous request (`[AUTH-3]`) without touching the database or Rebrickable (`[AUTH-6]`). A query shorter than two characters returns nothing and calls nothing. A search returns at most 10 sets, each with its set number, name, theme, year, piece count and stock image URL.
- `[CAT-2]` `[seed]` Every Rebrickable request goes through one client that sets a timeout of at most 5 seconds, sends at most one request per second from each server instance, and retries a 429 or 5xx answer at most twice with exponential backoff that honours `Retry-After`. It never retries past the caller's time budget, and it never logs the API key or a URL that carries it.
- `[CAT-3]` `[seed]` A set that has been looked up is stored in the `lego_set` table, with a UUID primary key (`[PLAT-13]`) and the set number as a unique key that every lookup and the items' foreign key use: name, theme name, year, piece count, stock image URL and when it was fetched. A lookup of a set number fetched in the last 30 days reads the table and makes no Rebrickable request. A search by name always asks Rebrickable, and stores every set it returns.
- `[CAT-4]` `[seed]` The Rebrickable API key is the SST secret `RebrickableApiKey`, named in `docs/deploy.md` (`[PLAT-3]`). It is read only on the server and never reaches the browser, a log line, the public snapshot or the offline queue.
- `[CAT-5]` `[seed]` When Rebrickable fails, times out or refuses the key, a search answers `unavailable` rather than an error page, and the entry form says that search is unavailable and still accepts a typed set number. A lookup failure never refuses a sign-in or any admin page.
