import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, numeric, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
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
 * What an item is (#202): a set, a minifigure, a bulk or unsorted lot, or any other LEGO item
 * (gear, a book, a keychain, instructions alone, an empty box). Existing rows are sets: the
 * column's database default is `SET`, so the code deployed before it keeps working ([ITEM-1]).
 */
export const KINDS = ['SET', 'MINIFIG', 'BULK', 'OTHER'] as const;
export type Kind = (typeof KINDS)[number];

export const MAX_NAME = 200;
export const MAX_REF_NO = 40;
export const MAX_APPROX_PARTS = 1_000_000;
export const MAX_APPROX_WEIGHT_G = 10_000_000;
/** The highest manual value an item may be given, in its currency ([VAL-5]). */
export const MAX_VALUE_OVERRIDE = 10_000_000;

/**
 * The owner's items: one row per set, minifigure, bulk lot or other item they hold (#124, #202, [ITEM-1]). The id is the client's own UUID,
 * made on the phone when the item is entered, so an item entered offline keeps its id through
 * the queue ([PLAT-13], [ITEM-7]). An item is a versioned record: every `saveItem` that changes it
 * moves `version` on by one, and a change made against another version is a conflict
 * ([ITEM-3], [SYNC-3]). Its photos' order and cover are not part of the version: they change
 * through `registerPhoto` and `setItemPhotos`, which an offline edit must not conflict with.
 *
 * `storage_location` is private: it never leaves the private side (`AGENTS.md` §1, [PUB-4]).
 * The condition and the kind are text with a check rather than a PostgreSQL enum, so a later one
 * is an additive change of a constraint, not of a type. A `SET` names its set through `set_num`;
 * a minifigure, a bulk lot or another item names itself through `name` and has no catalogue row
 * (#202, `collection_item_kind_identity_check`).
 */
export const collectionItem = pgTable(
  'collection_item',
  {
    // The client makes the id, and `saveItem` always gives it; the default is never used
    // ([PLAT-13]). The key refuses a second create of it ([ITEM-3]).
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    /** A set, a minifigure, a bulk lot or another item (#202); a database default, so older code's inserts are sets. */
    kind: text('kind', { enum: KINDS }).notNull().default('SET'),
    /** The set, for a `SET`; null for every other kind, which names itself instead (#202). */
    setNum: text('set_num').references(() => legoSet.setNum),
    /** A non-set's own name, plain text; null for a set, whose name is its catalogue row's. */
    name: text('name'),
    /** An optional reference number: a figure number such as `sw0001`, or a BrickLink item number. */
    refNo: text('ref_no'),
    /** A bulk lot's approximate piece count. */
    approxParts: integer('approx_parts'),
    /** A bulk lot's approximate weight, in grams. */
    approxWeightG: integer('approx_weight_g'),
    condition: text('condition', { enum: CONDITIONS }).notNull(),
    /** Always set for a set; optional, so null, for the other kinds (#202). */
    complete: boolean('complete'),
    /** What is missing, when the item is not complete. */
    missingNotes: text('missing_notes'),
    /** Always set for a set; optional, so null, for the other kinds (#202). */
    hasInstructions: boolean('has_instructions'),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    storageLocation: text('storage_location').notNull(),
    /** The item's cover, one of its own photos; null when it has none ([ITEM-6]). */
    coverPhotoId: uuid('cover_photo_id').references((): AnyPgColumn => photo.id, { onDelete: 'set null' }),
    /**
     * The owner's own value for the whole item, all of its quantity, in `manual_value_currency`
     * (#207, [VAL-5]): it replaces the market price. Null when none is set. Private, like every
     * value, and not part of the item's version: `setValueOverride` changes it, never `saveItem`.
     */
    manualValueOverride: numeric('manual_value_override', { precision: 20, scale: 3, mode: 'number' }),
    /** The override's currency, the deployment's when it was set; null with no override. */
    manualValueCurrency: text('manual_value_currency'),
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
    check('collection_item_kind_check', sql`${table.kind} in ('SET', 'MINIFIG', 'BULK', 'OTHER')`),
    // A set names its set; every other kind names itself (#202).
    check(
      'collection_item_kind_identity_check',
      sql`(${table.kind} = 'SET' and ${table.setNum} is not null) or (${table.kind} <> 'SET' and ${table.name} is not null)`,
    ),
    check('collection_item_name_check', sql`char_length(${table.name}) between 1 and ${sql.raw(String(MAX_NAME))}`),
    check('collection_item_ref_no_check', sql`char_length(${table.refNo}) between 1 and ${sql.raw(String(MAX_REF_NO))}`),
    check('collection_item_approx_parts_check', sql`${table.approxParts} between 1 and ${sql.raw(String(MAX_APPROX_PARTS))}`),
    check('collection_item_manual_value_override_check', sql`${table.manualValueOverride} >= 0`),
    check('collection_item_approx_weight_g_check', sql`${table.approxWeightG} between 1 and ${sql.raw(String(MAX_APPROX_WEIGHT_G))}`),
  ],
);
