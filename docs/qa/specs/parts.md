# Loose parts

The owner's loose parts, imported as lots from a BrickStore `.bsx` file or a BrickLink XML inventory export, with a summary and a few overview photos of the parts lot as a whole (`HANDOVER.md` §4.2). Seeded by the parts-import project (#153). The public catalogue shows only the parts summary and the overview photos. Values and the parts download belong to the valuation milestone (#5). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `PARTS`

## The file

- `[PARTS-1]` `[seed]` One parser reads both a BrickStore `.bsx` file and a BrickLink XML inventory export, and returns each lot's item type, item number, colour id, condition (`N` or `U`), quantity and unit price when the file has one. It never returns a lot's remarks, comments, bin, description or any other field. A lot with no item number (BrickStore saves a lot it never matched to a catalogue item with an empty one) is skipped, not refused, and the import reports how many were skipped and their places in the file. It refuses a file that isn't one of the two formats, has no lot with an item number, or has a lot without a positive whole quantity, and names the first such lot. It never resolves an external entity or a DTD, so a file can't make the server read or fetch anything.
- `[PARTS-2]` `[seed]` The file reaches the server the way a photo does (`[PHOTO-7]`): through a presigned upload into a private `imports/` prefix of the photo bucket that nothing serves. The upload expires within 15 minutes and is capped at a configured size, and a lifecycle rule deletes everything under the prefix after one day. `importPartsFile` reads the object, parses it and deletes it, whatever the import comes to. The file is never kept as it arrived.

## The inventory

- `[PARTS-3]` `[seed]` `importPartsFile` is a typed service function with zod-validated input that only an authenticated admin can call. It **replaces** the parts inventory: in one transaction it deletes every stored lot and inserts the file's lots, with a `parts_import` row recording the file's format, when it was imported, and its number of lots, total quantity and total value. An import that fails changes nothing. It is not a merge.
- `[PARTS-4]` `[seed]` `/admin/parts` shows the last import's summary: lots, total parts, total value when the file had prices, and when it was imported, plus the upload control and a warning, before a second import, that it replaces the current inventory. Every column of `parts_import` and `parts_lot` is classified in `[PUB-3]`'s registry, and unit prices and values are private.
- `[PARTS-5]` `[seed]` The parts lot has overview photos: up to 12, taken or picked on `/admin/parts`, through the same queued, re-encoded photo path as an item's photos (`[PHOTO-1]` to `[PHOTO-9]`), with an order. A photo belongs to an item or to the parts lot, never both.
