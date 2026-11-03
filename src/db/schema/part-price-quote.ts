import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { QUOTE_NEW_OR_USED, QUOTE_SOURCES } from './price-quote';

/**
 * What BrickLink prices a parts lot as, by its own type names ([VAL-8]): one for each of the
 * letters a parts file uses (`P`, `M`, `S`, `B`, `G`, `C`, `I`, `O`). A lot of any other type has
 * no BrickLink price, so no quote.
 */
export const PART_QUOTE_ITEM_TYPES = ['PART', 'MINIFIG', 'SET', 'BOOK', 'GEAR', 'CATALOG', 'INSTRUCTION', 'ORIGINAL_BOX'] as const;
export type PartQuoteItemType = (typeof PART_QUOTE_ITEM_TYPES)[number];

/**
 * The colour of a quote that is not for a part: BrickLink's colour 0, "(Not Applicable)". Only a
 * `PART` quote is asked for by its colour ([VAL-8]), so every other type's lots share one quote
 * whatever colour the file gave them.
 */
export const NO_COLOR = 0;

/**
 * The market prices of the loose parts' lots (brief #226, Issue A, [VAL-8]): one row per item
 * type, item number, colour and new-or-used, however many lots share it. The fields and their
 * rules are `price_quote`'s ([VAL-2] to [VAL-4], `./price-quote.ts`): `average` is the six-month
 * sold average in `currency`, null when nothing sold or BrickLink doesn't know the item;
 * `fetched_at` is the stored price's date; `attempted_at` is when it was last asked for, which
 * "fetched in the last 7 days" and "oldest first" go by; `last_error` is the last refusal, and a
 * failure never changes `average`, `sample_size` or `fetched_at`. Every column is private: a
 * price is a value (`[PUB-17]`).
 */
export const partPriceQuote = pgTable(
  'part_price_quote',
  {
    // The application makes every key, never the database ([PLAT-13]).
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    itemType: text('item_type', { enum: PART_QUOTE_ITEM_TYPES }).notNull(),
    itemNo: text('item_no').notNull(),
    /** BrickLink's colour id for a `PART`; `NO_COLOR` for every other type. */
    colorId: integer('color_id').notNull(),
    newOrUsed: text('new_or_used', { enum: QUOTE_NEW_OR_USED }).notNull(),
    average: numeric('average', { precision: 20, scale: 3, mode: 'number' }),
    sampleSize: integer('sample_size').notNull(),
    currency: text('currency').notNull(),
    source: text('source', { enum: QUOTE_SOURCES }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastError: text('last_error'),
  },
  (table) => [
    uniqueIndex('part_price_quote_item_idx').on(table.itemType, table.itemNo, table.colorId, table.newOrUsed),
    check('part_price_quote_item_type_check', sql`${table.itemType} in ('PART', 'MINIFIG', 'SET', 'BOOK', 'GEAR', 'CATALOG', 'INSTRUCTION', 'ORIGINAL_BOX')`),
    check('part_price_quote_new_or_used_check', sql`${table.newOrUsed} in ('N', 'U')`),
    check('part_price_quote_source_check', sql`${table.source} in ('bricklink')`),
    check('part_price_quote_color_id_check', sql`${table.colorId} >= 0`),
    check('part_price_quote_sample_size_check', sql`${table.sampleSize} >= 0`),
    check('part_price_quote_average_check', sql`${table.average} >= 0`),
  ],
);
