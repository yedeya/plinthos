import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { check, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** What BrickLink prices, by its own item types ([VAL-2]): a set, or a minifigure by its reference number. */
export const QUOTE_ITEM_TYPES = ['SET', 'MINIFIG'] as const;
/** New for a sealed item, used for any other condition ([VAL-2]). */
export const QUOTE_NEW_OR_USED = ['N', 'U'] as const;
/** Where a quote comes from: BrickLink's price guide alone (`HANDOVER.md` §10.5). */
export const QUOTE_SOURCES = ['bricklink'] as const;

/**
 * The market prices `refreshPrices` fetched (brief #207, Issue B, [VAL-2] to [VAL-4]): one row per
 * item type, item number and new-or-used, whichever items share it. Every column is private: a
 * price is a value, which the settings alone may show, through the projection (`[PUB-17]`).
 *
 * - `average` is the six-month sold average in `currency`; null when BrickLink knows the item but
 *   sold none, or knows it not at all (`last_error` then says `unknown-item`).
 * - `fetched_at` is when the stored price was fetched: a value's "as of" date. Null while no
 *   request for the quote has succeeded yet.
 * - `attempted_at` is when the quote was last asked for, answered or not: what "fetched in the
 *   last 7 days" and "oldest first" go by, so a quote that keeps failing does not hold up the rest.
 * - `last_error` is the last refusal for this quote, such as `unknown-item` or `timeout`; null
 *   after an answer with a price. A failure never changes `average`, `sample_size` or
 *   `fetched_at` ([VAL-4]).
 *
 * The item type, new-or-used and source are text with a check, not PostgreSQL enums, as the
 * other tables' fixed values are, so a later one is an additive change of a constraint.
 */
export const priceQuote = pgTable(
  'price_quote',
  {
    // The application makes every key, never the database ([PLAT-13]).
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    itemType: text('item_type', { enum: QUOTE_ITEM_TYPES }).notNull(),
    itemNo: text('item_no').notNull(),
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
    uniqueIndex('price_quote_item_idx').on(table.itemType, table.itemNo, table.newOrUsed),
    check('price_quote_item_type_check', sql`${table.itemType} in ('SET', 'MINIFIG')`),
    check('price_quote_new_or_used_check', sql`${table.newOrUsed} in ('N', 'U')`),
    check('price_quote_source_check', sql`${table.source} in ('bricklink')`),
    check('price_quote_sample_size_check', sql`${table.sampleSize} >= 0`),
    check('price_quote_average_check', sql`${table.average} >= 0`),
  ],
);
