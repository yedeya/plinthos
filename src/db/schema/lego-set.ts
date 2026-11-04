import { randomUUID } from 'node:crypto';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The sets the admin has looked up, cached from the set catalogue (Rebrickable, #124, [CAT-3]).
 * The set number is the key every lookup, upsert and item uses: Rebrickable's own, such as
 * `10179-1`, unique here, beside the UUID primary key the application makes ([PLAT-13]), as
 * [CAT-3] says. A row younger than 30 days answers a lookup without a request to Rebrickable; a search by name always asks Rebrickable and stores what it returns
 * (`src/server/catalogue/sets.ts`).
 *
 * Every item names its set here (`collection_item.set_num`), so an item is never stored without
 * its set's catalogue row ([ITEM-4]).
 */
export const legoSet = pgTable('lego_set', {
  // The application makes every primary key ([PLAT-13]); nothing references it.
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  setNum: text('set_num').notNull().unique(),
  name: text('name').notNull(),
  /** The theme's name, as the catalogue gives it. */
  theme: text('theme').notNull(),
  /**
   * Rebrickable's id for that theme. Null on a row stored before it was added, until
   * `backfillThemes` fills it ([ITEM-11], [ITEM-13]).
   */
  themeId: integer('theme_id'),
  /**
   * The name of the theme's top-level theme: the root of Rebrickable's theme tree above it, or the
   * theme itself when it has no parent. Null until it is filled ([ITEM-11]).
   */
  topTheme: text('top_theme'),
  year: integer('year').notNull(),
  numParts: integer('num_parts').notNull(),
  /** The catalogue's stock image, a URL on its CDN, when it has one. */
  imageUrl: text('image_url'),
  /** When the row was last fetched from the catalogue: what the 30-day freshness reads. */
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull(),
});
