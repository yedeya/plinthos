import { sql } from 'drizzle-orm';
import { boolean, check, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    askingPriceTotal: numeric('asking_price_total', { precision: 12, scale: 2, mode: 'number' }),
    askingPriceSealed: numeric('asking_price_sealed', { precision: 12, scale: 2, mode: 'number' }),
    askingPriceUsed: numeric('asking_price_used', { precision: 12, scale: 2, mode: 'number' }),
    askingPriceParts: numeric('asking_price_parts', { precision: 12, scale: 2, mode: 'number' }),
    unmigrated: text('unmigrated'),
  },
  (table) => [
    uniqueIndex('catalogue_settings_singleton').on(sql`(true)`),
    check('catalogue_settings_intro_text_check', sql`char_length(${table.introText}) <= 2000`),
    check('catalogue_settings_contact_text_check', sql`char_length(${table.contactText}) <= 2000`),
  ],
);
