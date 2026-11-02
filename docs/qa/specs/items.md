# Collection items

The sets the owner logs: one item per set they hold, with its condition, completeness, notes, quantity, private storage location and photos (`HANDOVER.md` §4.1). Seeded by the set-entry project (#124). No item is published yet: the public snapshot gains items with the public catalogue milestone. Values and prices belong to the valuation milestone. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `ITEM`

## The record

- `[ITEM-1]` `[seed]` An item is a `collection_item` row with a UUID the client makes (`[PLAT-13]`), a set number, `condition` (`SEALED`, `USED_WITH_BOX` or `USED_NO_BOX`), `complete` with an optional free-text note of what is missing, `has_instructions`, a description of at most 2,000 characters, a quantity from 1 to 999, a storage location of at most 200 characters, a version, and when it was created and last changed. Every one of its columns is classified in the `[PUB-3]` registry, and `storage_location` is private.
- `[ITEM-2]` `[seed]` `saveItem` creates or updates an item, and `deleteItem` deletes one. Both are typed service functions with zod-validated input, take an `AdminContext` (`AGENTS.md` §4), and are registered sync mutations, so the entry form, the offline queue and later tools all go through them (`[SYNC-1]`).
- `[ITEM-3]` `[seed]` An item is a versioned record (`[SYNC-3]`). `saveItem` carries `baseVersion`, null to create. A version that is not the item's current one is a `conflict`, answered with the server's item. Two creates of the same item id are a conflict and never an overwrite: the item's primary key refuses the second, and the replay answers it as a `version` conflict rather than `failed`.
- `[ITEM-4]` `[seed]` When `saveItem` names a set number that `lego_set` doesn't hold, it looks the set up on Rebrickable inside its own time budget (`[CAT-2]`, `[CAT-3]`). A set number Rebrickable doesn't know is refused as invalid with the code `unknown-set`, and the item is held on `/admin` for the owner to correct. A Rebrickable failure answers the mutation as `failed`, so the phone retries it with backoff (`[SYNC-8]`). An item is never stored without its set's catalogue row.
- `[ITEM-5]` `[seed]` `deleteItem` deletes the item and every photo linked to it. Each photo's stored sizes are deleted after the transaction commits, as `deletePhoto` does.

## Photos

- `[ITEM-6]` `[seed]` A photo belongs to at most one item. `registerPhoto` accepts an optional item id and position, and links the photo when the item exists. An item's photos have an order, and an item with photos has exactly one cover, which is the first photo until the owner picks another. `setItemPhotos` sets the order and the cover of an item's photos, and refuses a photo that isn't the item's. Deleting the cover makes the next photo the cover.
- `[ITEM-7]` `[seed]` On the phone, a new item's `saveItem` is queued before its photos' `registerPhoto` mutations, which carry the item's id, so an item and its photos entered offline sync in that order and arrive linked.

## Screens

- `[ITEM-8]` `[seed]` `/admin` lists the owner's items, newest first. Each shows its cover thumbnail through a presigned URL (`[PHOTO-6]`), set number, name, condition and quantity, and the list filters by set number or name as the owner types. Items still in the device's queue are listed too, marked as not synced.
- `[ITEM-9]` `[seed]` The entry form is one screen: set search or a typed set number, photos, condition, completeness, instructions, quantity, description and storage location. **Save & add next** queues the item and clears the form for the next set, keeping the condition and the storage location. The same form works on the offline shell, where the set number is typed rather than searched (`[SYNC-6]`: the shell stays data-free). An existing item is edited through the same form, online, and a stale edit meets the conflict rule above.
