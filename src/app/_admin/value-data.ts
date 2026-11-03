/**
 * The admin's values (brief #207, Issue B, [VAL-5], [VAL-7]): the checks of the edit form's
 * override and the settings page's adjustments, which are the service's own schemas
 * (`src/server/valuation/refresh.ts`) with their issues mapped to what the page says, and the
 * merge of each item's value into the list's rows. Server code: the actions and the pages call it.
 */
import type { ItemValue } from '../../server/valuation/values';
import { MAX_PARTS_PAGE, SaveValueAdjustmentsInput, SetValueOverrideInput } from '../../server/valuation/refresh';
import type { ListedItem } from '../_offline/items';

export type { CollectionTotals, ItemValue, PartsLotRow, PartsLotsPage, PartsValue } from '../../server/valuation/values';
export type { PriceRefreshRunView, PriceRefreshStatus, StartPriceRefreshInput, StartPriceRefreshResult, StopPriceRefreshResult } from '../../server/valuation/job';

/** Why an override was refused. */
export type OverrideProblem = 'notANumber' | 'tooLarge' | 'tooManyDecimals';

/** What the override's Save says ([VAL-7]). */
export type SaveOverrideResult =
  | { readonly status: 'saved'; readonly cleared: boolean }
  | { readonly status: 'invalid'; readonly problem: OverrideProblem }
  | { readonly status: 'unknown-item' };

/**
 * The amount the owner typed: blank is no override (null); a comma may be the decimal mark, and
 * spaces and apostrophes may group the thousands. Answers the amount, null, or the problem.
 */
export function parseOverride(text: string): number | null | OverrideProblem {
  const compact = text.trim().replace(/[\s'’]/g, '');
  if (compact === '') return null;
  // One comma and no dot is a decimal comma; otherwise commas group thousands.
  const normal = !compact.includes('.') && /^\d+,\d{1,}$/.test(compact) ? compact.replace(',', '.') : compact.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d+)?$/.test(normal)) return 'notANumber';
  const amount = Number(normal);
  const parsed = SetValueOverrideInput.shape.amount.safeParse(amount);
  if (parsed.success) return amount;
  return parsed.error.issues.some((issue) => issue.code === 'too_big') ? 'tooLarge' : 'tooManyDecimals';
}

/** The fields of the adjustments' form. */
export type AdjustmentField = 'usedWithBoxPct' | 'usedNoBoxPct';

/** What the adjustments' Save says: saved, or which field is out of range ([VAL-5]). */
export type SaveAdjustmentsResult =
  | { readonly status: 'saved' }
  | { readonly status: 'invalid'; readonly problems: Readonly<Partial<Record<AdjustmentField, 'outOfRange'>>> };

/** The adjustments as typed, checked by the service's own schema: the values, or what is wrong. */
export function checkAdjustments(form: { readonly usedWithBoxPct: string; readonly usedNoBoxPct: string }):
  | { readonly ok: true; readonly input: { readonly usedWithBoxPct: number; readonly usedNoBoxPct: number } }
  | { readonly ok: false; readonly result: SaveAdjustmentsResult } {
  const number = (text: string) => (text.trim() === '' ? 0 : /^[-+−]?\d+$/.test(text.trim()) ? Number(text.trim().replace('−', '-')) : Number.NaN);
  const input = { usedWithBoxPct: number(form.usedWithBoxPct), usedNoBoxPct: number(form.usedNoBoxPct) };
  const parsed = SaveValueAdjustmentsInput.safeParse(input);
  if (parsed.success) return { ok: true, input: parsed.data };
  const problems: Partial<Record<AdjustmentField, 'outOfRange'>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'usedWithBoxPct' || field === 'usedNoBoxPct') problems[field] = 'outOfRange';
  }
  return { ok: false, result: { status: 'invalid', problems } };
}

/** The list's rows, each with its value or null ([VAL-7]). */
export function withValues(items: readonly ListedItem[], values: ReadonlyMap<string, ItemValue | null>): ListedItem[] {
  return items.map((item) => ({ ...item, value: values.get(item.id) ?? null }));
}

/**
 * The page of lots `/admin/parts` asks for, from its `?page=` query ([VAL-11]): a whole number from
 * 1, at most `MAX_PARTS_PAGE`; anything else, or none, is the first page. A page past the last is
 * the service's to clamp.
 */
export function parsePartsPage(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined || !/^\d{1,6}$/.test(text)) return 1;
  const page = Number(text);
  return page < 1 ? 1 : Math.min(page, MAX_PARTS_PAGE);
}
