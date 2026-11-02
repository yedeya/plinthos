import { randomUUID } from 'node:crypto';
import { boolean, integer, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { legoSet } from './lego-set';
import { photo } from './photo';

/**
 * The sets the owner holds, one row per item ([ITEM-1], `src/server/items/items.ts`). The client
 * makes the id when the owner starts the entry, so an item logged offline keeps it through the
 * queue ([PLAT-13], [ITEM-7]).
 *
 * An item always has its set's catalogue row: `set_num` references `lego_set`, and `saveItem`
 * looks a set up before it stores the item ([ITEM-4]). `version` is the record's version for the
 * offline-sync conflict rule ([SYNC-3], [ITEM-3]). `cover_photo_id` is the photo the list shows,
 * which the database clears when that photo is deleted and the service then moves to the next
 * one ([ITEM-6]). `storage_location` is private ([ITEM-1], `AGENTS.md` §1).
 *
 * The bounds on each field (the conditions, the quantity, the lengths) are the service's zod
 * schema's, `SaveItemInput`, the one way an item is written.
 */
export const collectionItem = pgTable('collection_item', {
  // The client's own UUID for the item. The application makes every key, never the database ([PLAT-13]).
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  setNum: text('set_num')
    .notNull()
    .references(() => legoSet.setNum),
  /** `SEALED`, `USED_WITH_BOX` or `USED_NO_BOX`. */
  condition: text('condition').notNull(),
  complete: boolean('complete').notNull(),
  /** What is missing, for an incomplete item. */
  missingNote: text('missing_note'),
  hasInstructions: boolean('has_instructions').notNull(),
  description: text('description'),
  quantity: integer('quantity').notNull(),
  storageLocation: text('storage_location'),
  coverPhotoId: uuid('cover_photo_id').references((): AnyPgColumn => photo.id, { onDelete: 'set null' }),
  version: integer('version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});
