import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The catalogue's settings: one row, which the second migration inserts (`drizzle/`), and no UI
 * yet (brief #6, Issue D).
 *
 * `show_values` and `selling_mode` start at `HANDOVER.md` §7's default, false. The other two have
 * no default there, so they start null: `public_token` until the first publish makes it (#18),
 * and `selling_value_display` until selling mode is turned on, which nothing in the walking
 * skeleton can do. So `[PUB-4]`'s matrix starts from false, false and null.
 *
 * The singleton index, a unique index on a constant, refuses a second row.
 */
export const catalogueSettings = pgTable(
  'catalogue_settings',
  {
    // The application makes every key, never the database ([PLAT-13]).
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    publicToken: text('public_token'),
    showValues: boolean('show_values').notNull().default(false),
    sellingMode: boolean('selling_mode').notNull().default(false),
    sellingValueDisplay: text('selling_value_display'),
  },
  () => [uniqueIndex('catalogue_settings_singleton').on(sql`(true)`)],
);

/** The one row's key, which the seeding migration inserts. */
export const CATALOGUE_SETTINGS_ID = 'b1c48140-d308-424d-afdc-5f4a819a65c9';
