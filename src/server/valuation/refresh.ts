/**
 * The valuation's edits (brief #207, Issue B, `AGENTS.md` §4): `setValueOverride`, the edit form's
 * private override, and `saveValueAdjustments`, the settings page's per-condition adjustments
 * ([VAL-5], [VAL-7]), each an `adminOperation`: the admin check, then zod; and the reads the
 * admin's pages make of the values: `readAdminValues` for `/admin`, and `readPartsValues`, the
 * loose parts' value by source and a page of the lots, for `/admin/parts` ([VAL-6], [VAL-11]).
 *
 * The price refresh is the background job's since #226 (`./job.ts`, [VAL-3], [VAL-9]): **Refresh
 * prices** calls `startPriceRefresh`, and no page loops over BrickLink any more.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ADJUSTMENT_PCT_RANGE, catalogueSettings } from '../../db/schema/catalogue-settings';
import { collectionItem, MAX_VALUE_OVERRIDE } from '../../db/schema/collection-item';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger as defaultLogger, type Logger } from '../logger';
import { db } from '../transaction';
import { collectionTotals, deploymentCurrency, loadPartsLotsPage, loadValuation, type Adjustments, type CollectionTotals, type CollectionValues, type PartsLotsPage, type ValuesDatabase } from './values';

export const SetValueOverrideInput = z.strictObject({
  itemId: z.uuid(),
  /** The whole item's value, all of its quantity, to the cent; null takes the override away. */
  amount: z
    .number()
    .finite()
    .min(0)
    .max(MAX_VALUE_OVERRIDE)
    .refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6, { message: 'at most two decimals' })
    .nullable(),
});
export type SetValueOverrideInput = z.input<typeof SetValueOverrideInput>;

const AdjustmentPct = z.number().int().min(ADJUSTMENT_PCT_RANGE.min).max(ADJUSTMENT_PCT_RANGE.max);
export const SaveValueAdjustmentsInput = z.strictObject({ usedWithBoxPct: AdjustmentPct, usedNoBoxPct: AdjustmentPct });
export type SaveValueAdjustmentsInput = z.input<typeof SaveValueAdjustmentsInput>;

/** The highest page `/admin/parts` asks for: 50,000 lots ([PARTS-1]'s cap) are 500 pages of 100. */
export const MAX_PARTS_PAGE = 10_000;

export const ReadPartsValuesInput = z.strictObject({ page: z.number().int().min(1).max(MAX_PARTS_PAGE) });
export type ReadPartsValuesInput = z.input<typeof ReadPartsValuesInput>;

export interface ValuationDependencies {
  readonly log?: Logger;
  readonly currency?: () => string;
}

/** The collection's values and totals, for the admin's pages ([VAL-7]). */
export interface AdminValues {
  readonly values: CollectionValues;
  readonly totals: CollectionTotals;
}

/** Builds the valuation's service functions; deployed code uses the ones below. */
export function createValuationService(dependencies: ValuationDependencies = {}) {
  const log = dependencies.log ?? defaultLogger;
  const currency = dependencies.currency ?? (() => deploymentCurrency());

  const setValueOverride = adminOperation(
    SetValueOverrideInput,
    async (admin, input): Promise<{ readonly status: 'saved' | 'unknown-item'; readonly amount: number | null; readonly currency: string | null }> => {
      const value = input.amount === null ? { manualValueOverride: null, manualValueCurrency: null } : { manualValueOverride: input.amount, manualValueCurrency: currency() };
      // Not part of the item's version: an offline edit of the item never conflicts with it.
      const saved = await db().update(collectionItem).set(value).where(eq(collectionItem.id, input.itemId)).returning({ id: collectionItem.id });
      if (saved.length === 0) return { status: 'unknown-item', amount: null, currency: null };
      log.info({ requestId: admin.requestId, itemId: input.itemId, cleared: input.amount === null }, 'Saved an item’s manual value.');
      return { status: 'saved', amount: value.manualValueOverride, currency: value.manualValueCurrency };
    },
  );

  const saveValueAdjustments = adminOperation(SaveValueAdjustmentsInput, async (admin, input): Promise<Adjustments> => {
    const [saved] = await db()
      .update(catalogueSettings)
      .set({ adjustUsedWithBoxPct: input.usedWithBoxPct, adjustUsedNoBoxPct: input.usedNoBoxPct })
      .returning({ usedWithBoxPct: catalogueSettings.adjustUsedWithBoxPct, usedNoBoxPct: catalogueSettings.adjustUsedNoBoxPct });
    if (saved === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
    log.info({ requestId: admin.requestId }, 'Saved the value adjustments.');
    return saved;
  });

  async function readValueAdjustments(admin: AdminContext): Promise<Adjustments> {
    assertAdmin(admin);
    const [row] = await db()
      .select({ usedWithBoxPct: catalogueSettings.adjustUsedWithBoxPct, usedNoBoxPct: catalogueSettings.adjustUsedNoBoxPct })
      .from(catalogueSettings);
    if (row === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
    return row;
  }

  /** Every item's value and the totals per segment, for `/admin` ([VAL-7]). */
  async function readAdminValues(admin: AdminContext): Promise<AdminValues> {
    assertAdmin(admin);
    const { items, values } = await loadValuation(db() as unknown as ValuesDatabase, currency());
    return { values, totals: collectionTotals(items, values.items, values.parts) };
  }

  /**
   * The loose parts' value by source and one page of the lots, each with its unit price, value,
   * source and date, for `/admin/parts` ([VAL-6], [VAL-11]); null when nothing is imported.
   */
  async function readPartsValues(admin: AdminContext, input: ReadPartsValuesInput): Promise<PartsLotsPage | null> {
    assertAdmin(admin);
    const { page } = ReadPartsValuesInput.parse(input);
    return loadPartsLotsPage(db() as unknown as ValuesDatabase, page, currency());
  }

  return { setValueOverride, saveValueAdjustments, readValueAdjustments, readAdminValues, readPartsValues };
}

/** The valuation as deployed. */
export const valuation = createValuationService();

export const { setValueOverride, saveValueAdjustments, readValueAdjustments, readAdminValues, readPartsValues } = valuation;
