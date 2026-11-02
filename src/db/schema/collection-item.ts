import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { legoSet } from './lego-set';
import { photo } from './photo';

/** An item's condition ([ITEM-1], `HANDOVER.md` §4.1). */
export const CONDITIONS = ['SEALED', 'USED_WITH_BOX', 'USED_NO_BOX'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const MAX_DESCRIPTION = 2_000;
export const MAX_STORAGE_LOCATION = 200;
export const MAX_MISSING_NOTES = 2_000;
export const MAX_QUANTITY = 999;

/**
 * The owner's items: one row per set they hold (#124, [ITEM-1]). The id is the client's own UUID,
 * made on the phone when the item is entered, so an item entered offline keeps its id through
 * the queue ([PLAT-13], [ITEM-7]). An item is a versioned record: every `saveItem` that changes it
 * moves `version` on by one, and a change made against another version is a conflict
 * ([ITEM-3], [SYNC-3]). Its photos' order and cover are not part of the version: they change
 * through `registerPhoto` and `setItemPhotos`, which an offline edit must not conflict with.
 *
 * `storage_location` is private: it never leaves the private side (`AGENTS.md` §1, [PUB-4]).
 * The condition is text with a check rather than a PostgreSQL enum, so a later condition is an
 * additive change of a constraint, not of a type.
 */
export const collectionItem = pgTable(
  'collection_item',
  {
    // The client makes the id, and `saveItem` always gives it; the default is never used
    // ([PLAT-13]). The key refuses a second create of it ([ITEM-3]).
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    setNum: text('set_num')
      .notNull()
      .references(() => legoSet.setNum),
    condition: text('condition', { enum: CONDITIONS }).notNull(),
    complete: boolean('complete').notNull(),
    /** What is missing, when the item is not complete. */
    missingNotes: text('missing_notes'),
    hasInstructions: boolean('has_instructions').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    storageLocation: text('storage_location').notNull(),
    /** The item's cover, one of its own photos; null when it has none ([ITEM-6]). */
    coverPhotoId: uuid('cover_photo_id').references((): AnyPgColumn => photo.id, { onDelete: 'set null' }),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    check('collection_item_condition_check', sql`${table.condition} in ('SEALED', 'USED_WITH_BOX', 'USED_NO_BOX')`),
    check('collection_item_quantity_check', sql`${table.quantity} between 1 and ${sql.raw(String(MAX_QUANTITY))}`),
    check('collection_item_description_check', sql`char_length(${table.description}) <= ${sql.raw(String(MAX_DESCRIPTION))}`),
    check('collection_item_storage_location_check', sql`char_length(${table.storageLocation}) <= ${sql.raw(String(MAX_STORAGE_LOCATION))}`),
    check('collection_item_missing_notes_check', sql`char_length(${table.missingNotes}) <= ${sql.raw(String(MAX_MISSING_NOTES))}`),
  ],
);
