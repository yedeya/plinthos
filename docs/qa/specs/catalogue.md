# Set catalogue

How the admin finds a LEGO set and fills in its details from the Rebrickable catalogue (`HANDOVER.md` §4.1). Seeded by the set-entry project (#124). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `CAT`

## Lookup

- `[CAT-1]` `[seed]` The admin can search sets by set number or by name through an admin route that refuses an anonymous request (`[AUTH-3]`) without touching the database or Rebrickable (`[AUTH-6]`). A query shorter than two characters returns nothing and calls nothing. A search returns at most 10 sets, each with its set number, name, theme, year, piece count and stock image URL.
- `[CAT-2]` `[seed]` Every Rebrickable request goes through one client that sets a timeout of at most 5 seconds, sends at most one request per second from each server instance, and retries a 429 or 5xx answer at most twice with exponential backoff that honours `Retry-After`. It never retries past the caller's time budget, and it never logs the API key or a URL that carries it. A call whose request the browser has aborted sends nothing, stops waiting for its slot, and is not logged as a failure.
- `[CAT-3]` `[seed]` A set that has been looked up is stored in the `lego_set` table, with a UUID primary key (`[PLAT-13]`) and the set number as a unique key that every lookup and the items' foreign key use: name, theme name, year, piece count, stock image URL and when it was fetched. A lookup of a set number fetched in the last 30 days reads the table and makes no Rebrickable request. A search reads `lego_set` first. A search for a typed set number whose set it holds, fetched in the last 30 days, answers from the table and makes no Rebrickable request; any other search asks Rebrickable, and stores every set it returns, merged with the table's by set number.
- `[CAT-4]` `[seed]` The Rebrickable API key is the SST secret `RebrickableApiKey`, named in `docs/deploy.md` (`[PLAT-3]`). It is read only on the server and never reaches the browser, a log line, the public snapshot or the offline queue.
- `[CAT-5]` `[seed]` When Rebrickable fails, times out or refuses the key, a search never answers an error page: it answers the sets `lego_set` holds for the query, and the set the direct lookup found, marked `partial`, or `unavailable` when there are none. The entry form says quietly that search isn't answering, and still saves a typed set number from the same field. A lookup failure never refuses a sign-in or any admin page.
