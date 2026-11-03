import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    publishLease: uuid('publish_lease'),
    publishLeaseUntil: timestamp('publish_lease_until', { withTimezone: true, mode: 'date' }),
    introText: text('intro_text').notNull().default(''),
    contactText: text('contact_text').notNull().default(''),
    adjustUsedWithBoxPct: integer('adjust_used_with_box_pct').notNull().default(0),
    adjustUsedNoBoxPct: integer('adjust_used_no_box_pct').notNull().default(0),
    unmigrated: text('unmigrated'),
  },
  (table) => [
    uniqueIndex('catalogue_settings_singleton').on(sql`(true)`),
    check('catalogue_settings_intro_text_check', sql`char_length(${table.introText}) <= 2000`),
    check('catalogue_settings_contact_text_check', sql`char_length(${table.contactText}) <= 2000`),
    check('catalogue_settings_adjust_used_with_box_pct_check', sql`${table.adjustUsedWithBoxPct} between -100 and 100`),
    check('catalogue_settings_adjust_used_no_box_pct_check', sql`${table.adjustUsedNoBoxPct} between -100 and 100`),
  ],
);
