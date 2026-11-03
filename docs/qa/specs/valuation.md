# Valuation

Market values for the collection, as estimates with their source and date (`HANDOVER.md` §6). Seeded by the valuation project (#207). Values are private unless the owner shows them (`[PUB-17]` onwards). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `VAL`

## The price source

- `[VAL-1]` `[seed]` Every BrickLink request goes through one client that signs it with OAuth 1.0a (HMAC-SHA1) from the four SST secrets `BrickLinkConsumerKey`, `BrickLinkConsumerSecret`, `BrickLinkTokenValue` and `BrickLinkTokenSecret`, named in `docs/deploy.md` (`[PLAT-3]`). It sets a timeout of at most 10 seconds, sends at most one request per second from each server instance, retries a 429 or 5xx answer at most twice with backoff that honours `Retry-After`, never retries past the caller's time budget, and never logs a secret, a signature or a signed URL.
- `[VAL-2]` `[seed]` A price is BrickLink's price guide for the item: `guide_type=sold`, the average over its last six months, `new_or_used` `N` for a sealed set and `U` for a used one, in the deployment's currency (`PLINTHOS_CURRENCY`, default `EUR`). Each is stored in `price_quote` with the item type and number, new or used, the average, the sample size, the currency, the source and when it was fetched. A set's type is `SET` and its number its set number; a minifigure's type is `MINIFIG` and its number its reference number, and a minifigure without one has no price.

## Refreshing

- `[VAL-3]` `[seed]` Prices are refreshed only when the owner presses **Refresh prices** on `/admin`, never on a schedule and never on a public view (`HANDOVER.md` §6, `[PLAT-7]`). `refreshPrices` is a typed service function with zod-validated input that only an authenticated admin can call. One call refreshes as many quotes as fit its time budget, oldest first, and answers how many are done and how many are left, so the page calls it again until none are; a quote fetched in the last 7 days is not fetched again unless the owner asks for every price.
- `[VAL-4]` `[seed]` A refresh that fails for one item, unknown to BrickLink or refused, records that on the item's quote and goes on with the rest; one that fails for every request, a refused key or BrickLink unreachable, stops and says so on the page, and logs `price.refresh.failed` with the reason and never a secret. A failed refresh never deletes or changes a price it already had.

## Values

- `[VAL-5]` `[seed]` An item's value is its manual override when the owner set one; otherwise its price for its condition × its quantity, adjusted by the percentage the owner set for its condition (`USED_WITH_BOX` and `USED_NO_BOX`, default 0 %); otherwise none. A minifigure is priced like a set when it has a reference number (`[VAL-2]`); a bulk lot or an `OTHER` item has a value only from its override. Every value carries its source (`BrickLink`, `override` or none) and, for a BrickLink one, the date of its quote.
- `[VAL-6]` `[seed]` The loose parts' value is the sum of unit price × quantity over the imported lots with a price, in the file's currency, as `importPartsFile` records it (`[PARTS-3]`). It is never fetched from BrickLink per lot.
- `[VAL-7]` `[seed]` `/admin` shows each item's value and its source and date, and a total per segment: sealed, used and parts. The edit form takes a manual override, which is private; `/admin/settings` takes the per-condition adjustments. None of this reaches the public catalogue unless a setting shows it (`[PUB-17]`).
