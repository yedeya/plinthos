import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The committed schema with one column added and no migration for it, so the schema check must
 * fail on it ([PLAT-11], tests/db/migrations.test.ts). Never imported by the application.
 */
export const catalogueSettings = pgTable(
  'catalogue_settings',
  {
    id: uuid('id').primaryKey(),
    publicToken: text('public_token'),
    showValues: boolean('show_values').notNull().default(false),
    sellingMode: boolean('selling_mode').notNull().default(false),
    sellingValueDisplay: text('selling_value_display'),
    unmigrated: text('unmigrated'),
  },
  () => [uniqueIndex('catalogue_settings_singleton').on(sql`(true)`)],
);
