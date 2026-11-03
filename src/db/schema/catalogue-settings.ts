import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** The most characters the intro text and the contact text may hold ([PUB-9]). */
export const MAX_CATALOGUE_TEXT = 2_000;

/** The bounds of a per-condition value adjustment, in percent ([VAL-5]). */
export const ADJUSTMENT_PCT_RANGE = { min: -100, max: 100 } as const;

/**
 * The catalogue's settings: one row, which the second migration inserts (`drizzle/`), and no UI
 * yet (brief #6, Issue D).
 *
 * `show_values` and `selling_mode` start at `HANDOVER.md` §7's default, false. The other two have
 * no default there, so they start null: `public_token` until the first publish makes it (#19),
 * and `selling_value_display` until selling mode is turned on, which nothing in the walking
 * skeleton can do. So `[PUB-4]`'s matrix starts from false, false and null.
 *
 * `publish_lease` and `publish_lease_until` are the publish step's turn (#68): a publish takes them
 * before it reads anything and clears them when it ends, so two publishes never write the snapshot
 * at once. A publish that never cleared them, its function stopped mid-way, loses the turn when
 * `publish_lease_until` passes (`src/server/publish/projection.ts`).
 *
 * `intro_text` and `contact_text` are what a visitor reads on the landing page (#162, [PUB-9]):
 * plain text the owner writes on `/admin/settings`, public, and published only at the next
 * publish. They have a database default, `''`, so the code deployed before them keeps working.
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
    publishLease: uuid('publish_lease'),
    publishLeaseUntil: timestamp('publish_lease_until', { withTimezone: true, mode: 'date' }),
    introText: text('intro_text').notNull().default(''),
    contactText: text('contact_text').notNull().default(''),
    // The per-condition adjustments of a market price, in percent (#207, [VAL-5], `HANDOVER.md`
    // §10.8): private, and a database default of 0, so the code deployed before them keeps working.
    adjustUsedWithBoxPct: integer('adjust_used_with_box_pct').notNull().default(0),
    adjustUsedNoBoxPct: integer('adjust_used_no_box_pct').notNull().default(0),
  },
  (table) => [
    uniqueIndex('catalogue_settings_singleton').on(sql`(true)`),
    check('catalogue_settings_intro_text_check', sql`char_length(${table.introText}) <= ${sql.raw(String(MAX_CATALOGUE_TEXT))}`),
    check('catalogue_settings_contact_text_check', sql`char_length(${table.contactText}) <= ${sql.raw(String(MAX_CATALOGUE_TEXT))}`),
    check('catalogue_settings_adjust_used_with_box_pct_check', sql`${table.adjustUsedWithBoxPct} between -100 and 100`),
    check('catalogue_settings_adjust_used_no_box_pct_check', sql`${table.adjustUsedNoBoxPct} between -100 and 100`),
  ],
);

/** The one row's key, which the seeding migration inserts. */
export const CATALOGUE_SETTINGS_ID = 'b1c48140-d308-424d-afdc-5f4a819a65c9';
