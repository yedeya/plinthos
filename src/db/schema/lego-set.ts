import { randomUUID } from 'node:crypto';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The set catalogue's cache: every set the admin has looked up, one row each ([CAT-3],
 * `src/server/catalogue/sets.ts`). A lookup of a set fetched in the last 30 days reads this table
 * and asks Rebrickable nothing; a search by name always asks, and stores every set it returns.
 *
 * The set number is the row's identity, held by its unique constraint, which an item's set number
 * references (`./collection-item.ts`). The primary key is a UUID like every table's ([PLAT-13]).
 * Nothing here is the owner's: it is Rebrickable's public catalogue data, and when it was fetched.
 */
export const legoSet = pgTable('lego_set', {
  // The application makes every key, never the database ([PLAT-13]).
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  /** Rebrickable's set number, with its variant suffix, such as `10294-1`. */
  setNum: text('set_num').notNull().unique(),
  name: text('name').notNull(),
  /** The theme's own name, such as `Icons`. */
  theme: text('theme').notNull(),
  year: integer('year').notNull(),
  numParts: integer('num_parts').notNull(),
  /** The stock image on Rebrickable's CDN, or null when it has none. */
  imageUrl: text('image_url'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
});
