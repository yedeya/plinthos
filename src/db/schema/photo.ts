import { randomUUID } from 'node:crypto';
import { integer, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { collectionItem } from './collection-item';

/**
 * The owner's stored photos, one row each (#22, `src/server/photos/`). A photo belongs to at most
 * one item, by `item_id`, and has a `position` among that item's photos ([ITEM-6]); a photo with
 * neither belongs to no item. No photo is published yet: the public catalogue milestone does that.
 *
 * A row is written only after both re-encoded sizes are in the private photo bucket, in the same
 * transaction as the applied-mutation record of the `registerPhoto` that made it ([PHOTO-3]), so a
 * row always has its files. The keys are random and made by the server ([PHOTO-6]); nothing here
 * holds the client's id, the quarantine key or the uploaded bytes.
 */
export const photo = pgTable('photo', {
  // The application makes every key, never the database ([PLAT-13]).
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  fullKey: text('full_key').notNull().unique(),
  thumbnailKey: text('thumbnail_key').notNull().unique(),
  /** The SHA-256 of the bytes the phone uploaded, as hex: what `registerPhoto` checked them by. */
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  /** The item the photo belongs to. `deleteItem` deletes its photos itself, and their files after ([ITEM-5]). */
  itemId: uuid('item_id').references((): AnyPgColumn => collectionItem.id),
  /** Its place among the item's photos, from 0; the order is by position, then by when it was added. */
  position: integer('position'),
});
