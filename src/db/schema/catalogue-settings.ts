import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** The most characters the intro text and the contact text may hold ([PUB-9]). */
export const MAX_CATALOGUE_TEXT = 2_000;

/** The bounds of a per-condition value adjustment, in percent ([VAL-5]). */
export const ADJUSTMENT_PCT_RANGE = { min: -100, max: 100 } as const;

/**
 * What selling mode shows ([PUB-18]): the asking prices alone, the market values alone, or both.
 * `ASKING` is the default the first time selling mode is turned on (`HANDOVER.md` §10.9).
 */
export const SELLING_VALUE_DISPLAYS = ['ASKING', 'MARKET', 'BOTH'] as const;
export type SellingValueDisplay = (typeof SELLING_VALUE_DISPLAYS)[number];

/** The highest asking price the settings take, in the deployment's currency (#211). */
export const MAX_ASKING_PRICE = 1_000_000_000;

/**
 * The catalogue's settings: one row, which the second migration inserts (`drizzle/`), set on
 * `/admin/settings` (`src/server/settings/`).
 *
 * `show_values` and `selling_mode` start at `HANDOVER.md` §7's default, false. The other two have
 * no default there, so they start null: `public_token` until the first publish makes it (#19),
 * and `selling_value_display` until selling mode is first turned on, when it becomes `ASKING`
 * (#211, [PUB-18]); a check holds it to one of `SELLING_VALUE_DISPLAYS`. So `[PUB-4]`'s matrix
 * starts from false, false and null.
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
 * `asking_price_total`, `asking_price_sealed`, `asking_price_used` and `asking_price_parts` are
 * the owner's asking prices in selling mode (#211, [PUB-18]): overall and per segment, in the
 * deployment's currency, null until the owner enters one. They are private, like every price
 * (`./classification.ts`): the projection publishes them only while selling mode is on and
 * `selling_value_display` shows them, and never because one is stored.
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
    sellingValueDisplay: text('selling_value_display', { enum: SELLING_VALUE_DISPLAYS }),
    publishLease: uuid('publish_lease'),
    publishLeaseUntil: timestamp('publish_lease_until', { withTimezone: true, mode: 'date' }),
    introText: text('intro_text').notNull().default(''),
    contactText: text('contact_text').notNull().default(''),
    askingPriceTotal: numeric('asking_price_total', { precision: 12, scale: 2, mode: 'number' }),
    askingPriceSealed: numeric('asking_price_sealed', { precision: 12, scale: 2, mode: 'number' }),
    askingPriceUsed: numeric('asking_price_used', { precision: 12, scale: 2, mode: 'number' }),
    askingPriceParts: numeric('asking_price_parts', { precision: 12, scale: 2, mode: 'number' }),
    // The per-condition adjustments of a market price, in percent (#207, [VAL-5], `HANDOVER.md`
    // §10.8): private, and a database default of 0, so the code deployed before them keeps working.
    adjustUsedWithBoxPct: integer('adjust_used_with_box_pct').notNull().default(0),
    adjustUsedNoBoxPct: integer('adjust_used_no_box_pct').notNull().default(0),
  },
  (table) => [
    uniqueIndex('catalogue_settings_singleton').on(sql`(true)`),
    check('catalogue_settings_intro_text_check', sql`char_length(${table.introText}) <= ${sql.raw(String(MAX_CATALOGUE_TEXT))}`),
    check('catalogue_settings_contact_text_check', sql`char_length(${table.contactText}) <= ${sql.raw(String(MAX_CATALOGUE_TEXT))}`),
    check('catalogue_settings_selling_value_display_check', sql`${table.sellingValueDisplay} in ('ASKING', 'MARKET', 'BOTH')`),
    ...(['askingPriceTotal', 'askingPriceSealed', 'askingPriceUsed', 'askingPriceParts'] as const).map((column) =>
      check(`catalogue_settings_${table[column].name}_check`, sql`${table[column]} between 0 and ${sql.raw(String(MAX_ASKING_PRICE))}`),
    ),
    check('catalogue_settings_adjust_used_with_box_pct_check', sql`${table.adjustUsedWithBoxPct} between -100 and 100`),
    check('catalogue_settings_adjust_used_no_box_pct_check', sql`${table.adjustUsedNoBoxPct} between -100 and 100`),
  ],
);

/** The one row's key, which the seeding migration inserts. */
export const CATALOGUE_SETTINGS_ID = 'b1c48140-d308-424d-afdc-5f4a819a65c9';
