/**
 * The collection's values (brief #207, Issue B, [VAL-5] to [VAL-7]): pure functions that value an
 * item and total the collection by segment, and `readCollectionValues`, the one read of them the
 * publish step's projection may make (`./contract.ts`, Issue C).
 *
 * **An item's value** ([VAL-5]) is, in this order:
 * 1. its manual override, when the owner set one: the value of the whole item, all of its
 *    quantity, in the override's currency, with the source `override`;
 * 2. otherwise, for a set, and for a minifigure with a reference number, its BrickLink quote for
 *    its condition (new for `SEALED`, used for either used condition) × its quantity, adjusted by
 *    the owner's percentage for `USED_WITH_BOX` or `USED_NO_BOX` (0 % by default; a sealed item is
 *    never adjusted), in the quote's currency, with the source `bricklink` and the quote's date;
 * 3. otherwise none. A bulk lot and an `OTHER` item have a value only from an override.
 *
 * **The segments** ([VAL-7]), which `segmentOf` decides and the totals follow:
 * - **sealed**: a `SET` in `SEALED` condition, and an `OTHER` item in `SEALED` condition;
 * - **used**: a `SET` in a used condition, every `MINIFIG` whatever its condition, and an `OTHER`
 *   item in a used condition;
 * - **parts**: the imported loose parts' value, `parts_import.total_value` ([VAL-6]), and every
 *   `BULK` lot, which is loose parts too.
 *
 * A bulk lot and an `OTHER` item count in a total only through their override, since they have no
 * other value. A total holds one amount per currency: values in different currencies are never
 * added together or converted.
 *
 * Everything here is private: none of it reaches the catalogue unless a setting shows it, and the
 * projection decides that ([PUB-17]).
 */
import { inArray } from 'drizzle-orm';
import { catalogueSettings } from '../../db/schema/catalogue-settings';
import { collectionItem, type Condition, type Kind } from '../../db/schema/collection-item';
import { partsImport } from '../../db/schema/parts';
import { priceQuote } from '../../db/schema/price-quote';
import type { CollectionValues, ItemValue, ValuesDatabase } from './contract';

export type { CollectionValues, ItemValue, ValuesDatabase } from './contract';

/** The deployment's currency's variable (`infra/config.ts`, #209) and its default ([VAL-2]). */
export const CURRENCY_ENV = 'PLINTHOS_CURRENCY';
export const DEFAULT_CURRENCY = 'EUR';

/** The deployment's currency: `PLINTHOS_CURRENCY` when it is a three-letter code, else `EUR`. */
export function deploymentCurrency(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env[CURRENCY_ENV]?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(value) ? value : DEFAULT_CURRENCY;
}

/** What valuing an item reads of it. */
export interface ValuedItem {
  readonly id: string;
  readonly kind: Kind;
  readonly condition: Condition;
  readonly quantity: number;
  readonly setNum: string | null;
  readonly refNo: string | null;
  readonly manualValueOverride: number | null;
  readonly manualValueCurrency: string | null;
}

/** The quote an item needs ([VAL-2]): BrickLink's item type and number, and new or used. */
export interface QuoteKey {
  readonly itemType: 'SET' | 'MINIFIG';
  readonly itemNo: string;
  readonly newOrUsed: 'N' | 'U';
}

/** A stored quote, as valuing reads it. */
export interface StoredQuote extends QuoteKey {
  readonly average: number | null;
  readonly currency: string;
  /** When the price was fetched; null while none has been. */
  readonly fetchedAt: Date | null;
}

/** The owner's per-condition adjustments, in percent, from -100 to 100 ([VAL-5]). */
export interface Adjustments {
  readonly usedWithBoxPct: number;
  readonly usedNoBoxPct: number;
}

export const NO_ADJUSTMENTS: Adjustments = { usedWithBoxPct: 0, usedNoBoxPct: 0 };

/** One string per quote key, for maps and deduplication. */
export function quoteKeyString(key: QuoteKey): string {
  return `${key.itemType}\u0000${key.itemNo}\u0000${key.newOrUsed}`;
}

/** The quote an item is priced by, or null for one BrickLink doesn't price ([VAL-2]). */
export function quoteKeyOf(item: Pick<ValuedItem, 'kind' | 'condition' | 'setNum' | 'refNo'>): QuoteKey | null {
  const newOrUsed = item.condition === 'SEALED' ? 'N' : 'U';
  if (item.kind === 'SET' && item.setNum !== null && item.setNum !== '') return { itemType: 'SET', itemNo: item.setNum, newOrUsed };
  if (item.kind === 'MINIFIG' && item.refNo !== null && item.refNo.trim() !== '') return { itemType: 'MINIFIG', itemNo: item.refNo.trim(), newOrUsed };
  return null;
}

/** An amount rounded to the cent. */
function cents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** The percentage that adjusts a market price for this condition: none for a sealed item. */
export function adjustmentFor(condition: Condition, adjustments: Adjustments): number {
  if (condition === 'USED_WITH_BOX') return adjustments.usedWithBoxPct;
  if (condition === 'USED_NO_BOX') return adjustments.usedNoBoxPct;
  return 0;
}

/**
 * One item's value ([VAL-5]): its override, else its quote × quantity adjusted for its condition,
 * else null. `quote` is the stored quote for `quoteKeyOf(item)`, or null; `currency` is the
 * deployment's, for an override stored without one.
 */
export function itemValue(item: ValuedItem, quote: StoredQuote | null, adjustments: Adjustments, currency: string = DEFAULT_CURRENCY): ItemValue | null {
  if (item.manualValueOverride !== null) {
    return { amount: cents(item.manualValueOverride), currency: item.manualValueCurrency ?? currency, source: 'override', asOf: null };
  }
  const key = quoteKeyOf(item);
  if (key === null || quote === null || quoteKeyString(key) !== quoteKeyString(quote)) return null;
  if (quote.average === null || quote.fetchedAt === null) return null;
  const factor = 1 + adjustmentFor(item.condition, adjustments) / 100;
  return { amount: cents(quote.average * item.quantity * factor), currency: quote.currency, source: 'bricklink', asOf: quote.fetchedAt.toISOString() };
}

export const SEGMENTS = ['sealed', 'used', 'parts'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** The segment an item's value counts in ([VAL-7]); the module comment states the rule. */
export function segmentOf(item: Pick<ValuedItem, 'kind' | 'condition'>): Segment {
  switch (item.kind) {
    case 'BULK':
      return 'parts';
    case 'MINIFIG':
      return 'used';
    case 'SET':
    case 'OTHER':
      return item.condition === 'SEALED' ? 'sealed' : 'used';
  }
}

/** One amount in one currency. */
export interface Amount {
  readonly amount: number;
  readonly currency: string;
}

/** A segment's total: one amount per currency, and how many of its entries have a value and how many don't. */
export interface SegmentTotal {
  readonly amounts: readonly Amount[];
  readonly valued: number;
  readonly unvalued: number;
}

export interface CollectionTotals {
  readonly sealed: SegmentTotal;
  readonly used: SegmentTotal;
  readonly parts: SegmentTotal;
  /** Every segment together, one amount per currency. */
  readonly all: SegmentTotal;
}

function total(entries: readonly (Amount | null)[]): SegmentTotal {
  const sums = new Map<string, number>();
  let valued = 0;
  for (const entry of entries) {
    if (entry === null) continue;
    valued += 1;
    sums.set(entry.currency, (sums.get(entry.currency) ?? 0) + entry.amount);
  }
  const amounts = [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: cents(amount) }));
  return { amounts, valued, unvalued: entries.length - valued };
}

/**
 * The totals per segment ([VAL-7]): each item's value in its segment, and the parts import's in
 * `parts`. An item with no value counts as unvalued; the parts with no prices count as nothing.
 */
export function collectionTotals(
  items: readonly Pick<ValuedItem, 'id' | 'kind' | 'condition'>[],
  values: ReadonlyMap<string, ItemValue | null>,
  parts: Amount | null,
): CollectionTotals {
  const bySegment: Record<Segment, (Amount | null)[]> = { sealed: [], used: [], parts: [] };
  for (const item of items) bySegment[segmentOf(item)].push(values.get(item.id) ?? null);
  if (parts !== null) bySegment.parts.push(parts);
  return {
    sealed: total(bySegment.sealed),
    used: total(bySegment.used),
    parts: total(bySegment.parts),
    all: total([...bySegment.sealed, ...bySegment.used, ...bySegment.parts]),
  };
}

/** Everything valuing the collection read, and the values made from it. */
export interface Valuation {
  readonly items: readonly ValuedItem[];
  readonly values: CollectionValues;
}

/**
 * Reads what valuing needs, and values it: each item's own value fields, never its storage
 * location or anything else; the quotes the items name; the adjustments; and the parts' total.
 */
export async function loadValuation(db: ValuesDatabase, currency: string = deploymentCurrency()): Promise<Valuation> {
  const items: ValuedItem[] = await db
    .select({
      id: collectionItem.id,
      kind: collectionItem.kind,
      condition: collectionItem.condition,
      quantity: collectionItem.quantity,
      setNum: collectionItem.setNum,
      refNo: collectionItem.refNo,
      manualValueOverride: collectionItem.manualValueOverride,
      manualValueCurrency: collectionItem.manualValueCurrency,
    })
    .from(collectionItem);
  const [settings] = await db
    .select({ usedWithBoxPct: catalogueSettings.adjustUsedWithBoxPct, usedNoBoxPct: catalogueSettings.adjustUsedNoBoxPct })
    .from(catalogueSettings);
  const adjustments: Adjustments = settings ?? NO_ADJUSTMENTS;
  const keys = items.map(quoteKeyOf).filter((key): key is QuoteKey => key !== null);
  const itemNos = [...new Set(keys.map((key) => key.itemNo))];
  const quotes = new Map<string, StoredQuote>();
  if (itemNos.length > 0) {
    const rows = await db
      .select({
        itemType: priceQuote.itemType,
        itemNo: priceQuote.itemNo,
        newOrUsed: priceQuote.newOrUsed,
        average: priceQuote.average,
        currency: priceQuote.currency,
        fetchedAt: priceQuote.fetchedAt,
      })
      .from(priceQuote)
      .where(inArray(priceQuote.itemNo, itemNos));
    for (const row of rows) quotes.set(quoteKeyString(row), { ...row, average: row.average === null ? null : Number(row.average) });
  }
  const values = new Map<string, ItemValue | null>();
  for (const item of items) {
    const key = quoteKeyOf(item);
    const override = item.manualValueOverride === null ? null : Number(item.manualValueOverride);
    values.set(item.id, itemValue({ ...item, manualValueOverride: override }, key === null ? null : (quotes.get(quoteKeyString(key)) ?? null), adjustments, currency));
  }
  const [imported] = await db.select({ totalValue: partsImport.totalValue, currency: partsImport.currency }).from(partsImport);
  // The file's own currency ([VAL-6]); a file that named none is taken to be in the deployment's.
  const parts = imported === undefined || imported.totalValue === null ? null : { amount: cents(Number(imported.totalValue)), currency: imported.currency ?? currency };
  return { items, values: { items: values, parts, currency } };
}

/**
 * The values the publish step may read (`./contract.ts`): every item's value by its id, the
 * loose parts' value and the deployment's currency. It reads only the values, never a storage
 * location or an asking price, and checks no admin: the projection that calls it runs inside a
 * publish, which did.
 */
export async function readCollectionValues(db: ValuesDatabase): Promise<CollectionValues> {
  return (await loadValuation(db)).values;
}
