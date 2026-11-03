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
 * - **parts**: the imported loose parts' value ([VAL-6], below), and every `BULK` lot, which is
 *   loose parts too.
 *
 * **A parts lot's value** ([VAL-6], #229) is, in this order:
 * 1. its BrickLink average for its quote key (`partQuoteKeyOf`, [VAL-8]) × its quantity, when the
 *    quote has an average in the deployment's currency, with the source `bricklink` and the
 *    quote's date;
 * 2. otherwise the file's unit price × its quantity, when the file's currency is the deployment's
 *    or the file names none (a BrickLink XML export never does), with the source `file`;
 * 3. otherwise none.
 * Every lot's value is rounded to the cent once, half up, in exact integer arithmetic (both prices
 * have at most three decimals), and the loose parts' value is the exact sum of those cents, so
 * the lots `/admin/parts` lists add up to its total. The inventory can hold thousands of lots, so
 * the lots and the quotes are each read in pages of `LOT_PAGE` and joined in memory, never one
 * query per lot.
 *
 * A bulk lot and an `OTHER` item count in a total only through their override, since they have no
 * other value. A total holds one amount per currency: values in different currencies are never
 * added together or converted.
 *
 * Everything here is private: none of it reaches the catalogue unless a setting shows it, and the
 * projection decides that ([PUB-17]).
 */
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { catalogueSettings } from '../../db/schema/catalogue-settings';
import { collectionItem, type Condition, type Kind } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { partPriceQuote } from '../../db/schema/part-price-quote';
import { partsImport, partsLot } from '../../db/schema/parts';
import { priceQuote } from '../../db/schema/price-quote';
import { LOT_PAGE } from '../parts/lots';
import type { CollectionValues, ItemValue, PartsValue, ValuesDatabase } from './contract';
import { partQuoteKeyOf, partQuoteKeyString, type PartQuoteKey, type PartsLotKeyFields } from './part-quotes';

export type { CollectionValues, ItemValue, PartsValue, ValuesDatabase } from './contract';

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
  /** The set's theme, as Rebrickable names it (`lego_set.theme`); null or absent when unknown. */
  readonly theme?: string | null;
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

/** Rebrickable's theme for a numbered series of collectible minifigures, such as `Series 21 Minifigures`. */
const NUMBERED_SERIES_THEME = /^Series (\d{1,2}) Minifigures$/;

/**
 * BrickLink's set number for a set that Rebrickable numbers `setNum` in `theme` ([VAL-2]), or null
 * when BrickLink's number isn't known. The two catalogues number most sets alike, but not the
 * collectible minifigures: Rebrickable numbers a series' figures `<box>-<n>` and its random bag
 * `<box>-0`, while BrickLink numbers the figure `col<series, two digits>-<n>` and the random bag
 * `<box>-1` ("Complete Random Set of 1 Minifigure"). Under Rebrickable's figure numbers BrickLink
 * holds other things (`71029-2` is the complete series of 12), so a set in such a theme is never
 * asked for under Rebrickable's own number. The mapping was checked against BrickLink's catalogue
 * on 2026-11-03 for series 1, 9, 10, 16 to 22, 25 and 26 (#241).
 */
export function bricklinkSetNo(setNum: string, theme: string | null | undefined): string | null {
  const series = theme ? NUMBERED_SERIES_THEME.exec(theme.trim()) : null;
  if (series === null) return setNum;
  const figure = /^(\d+)-(\d+)$/.exec(setNum);
  if (figure === null) return null;
  const [, box, n] = figure;
  if (Number(n) === 0) return `${box}-1`;
  return `col${String(Number(series[1])).padStart(2, '0')}-${Number(n)}`;
}

/** The quote an item is priced by, or null for one BrickLink doesn't price ([VAL-2]). */
export function quoteKeyOf(item: Pick<ValuedItem, 'kind' | 'condition' | 'setNum' | 'refNo' | 'theme'>): QuoteKey | null {
  const newOrUsed = item.condition === 'SEALED' ? 'N' : 'U';
  if (item.kind === 'SET' && item.setNum !== null && item.setNum !== '') {
    const itemNo = bricklinkSetNo(item.setNum, item.theme);
    return itemNo === null ? null : { itemType: 'SET', itemNo, newOrUsed };
  }
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
 * The totals per segment ([VAL-7]): each item's value in its segment, and the loose parts' value
 * ([VAL-6]) in `parts`. An item with no value counts as unvalued; loose parts with no value count
 * as nothing (`/admin/parts` counts their lots).
 */
export function collectionTotals(
  items: readonly Pick<ValuedItem, 'id' | 'kind' | 'condition'>[],
  values: ReadonlyMap<string, ItemValue | null>,
  parts: { readonly amount: number | null; readonly currency: string } | null,
): CollectionTotals {
  const bySegment: Record<Segment, (Amount | null)[]> = { sealed: [], used: [], parts: [] };
  for (const item of items) bySegment[segmentOf(item)].push(values.get(item.id) ?? null);
  if (parts !== null && parts.amount !== null) bySegment.parts.push({ amount: parts.amount, currency: parts.currency });
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
      theme: legoSet.theme,
      refNo: collectionItem.refNo,
      manualValueOverride: collectionItem.manualValueOverride,
      manualValueCurrency: collectionItem.manualValueCurrency,
    })
    .from(collectionItem)
    .leftJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum));
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
  const lots = await loadPartsLots(db, currency);
  const parts = lots === null ? null : partsValue(lots.lots.map((lot) => lot.value), currency);
  const partsLots = new Map((lots?.lots ?? []).map((lot) => [lot.id, lot.value === null ? null : lot.value.amount] as const));
  return { items, values: { items: values, parts, partsLots, currency } };
}

// ---------------------------------------------------------------------------------------------
// The loose parts ([VAL-6], #229)
// ---------------------------------------------------------------------------------------------

/** A stored part quote, as valuing reads it. */
export interface StoredPartQuote extends PartQuoteKey {
  readonly average: number | null;
  readonly currency: string;
  /** When the price was fetched; null while none has been. */
  readonly fetchedAt: Date | null;
}

/** What valuing a parts lot reads of it: its quote key's fields, its quantity and the file's unit price. */
export interface ValuedPartsLot extends PartsLotKeyFields {
  readonly lotQuantity: number;
  /** The file's unit price, in the file's currency; null when the file had none for the lot. */
  readonly unitPrice: number | null;
}

/** Where a parts lot's value comes from ([VAL-6]). */
export type PartsValueSource = 'bricklink' | 'file';

/** A parts lot's value: the amount for its whole quantity, in the deployment's currency. */
export interface PartsLotValue {
  readonly amount: number;
  /** The unit price the value is from: BrickLink's average, or the file's price, in the deployment's currency. */
  readonly unitPrice: number;
  readonly source: PartsValueSource;
  /** The quote's fetched-at time for a BrickLink value, ISO 8601; null for the file's. */
  readonly asOf: string | null;
}

/**
 * A unit price × a quantity, in whole cents, rounded half up once. A price has at most three
 * decimals (`numeric(…, 3)`), so it is taken in exact thousandths first: no float error can move
 * a half cent.
 */
export function lotCents(unitPrice: number, quantity: number): number {
  const thousandths = Math.round(unitPrice * 1000) * quantity;
  return Math.floor((thousandths + 5) / 10);
}

/**
 * One parts lot's value ([VAL-6]): BrickLink's average × quantity when the lot's quote has one in
 * the deployment's currency; otherwise the file's unit price × quantity when the file is in the
 * deployment's currency or names none; otherwise null. `quote` is the stored quote for
 * `partQuoteKeyOf(lot)`, or null; `fileCurrency` is the file's, null when it named none.
 */
export function partsLotValue(lot: ValuedPartsLot, quote: StoredPartQuote | null, fileCurrency: string | null, currency: string): PartsLotValue | null {
  const key = partQuoteKeyOf(lot);
  if (key !== null && quote !== null && partQuoteKeyString(key) === partQuoteKeyString(quote) && quote.average !== null && quote.fetchedAt !== null && quote.currency === currency) {
    return { amount: lotCents(quote.average, lot.lotQuantity) / 100, unitPrice: quote.average, source: 'bricklink', asOf: quote.fetchedAt.toISOString() };
  }
  if (lot.unitPrice !== null && (fileCurrency === null || fileCurrency === currency)) {
    return { amount: lotCents(lot.unitPrice, lot.lotQuantity) / 100, unitPrice: lot.unitPrice, source: 'file', asOf: null };
  }
  return null;
}

/** The loose parts' value ([VAL-6]): the exact sum of the lots' cents, and the lots per source. */
export function partsValue(values: Iterable<PartsLotValue | null>, currency: string): PartsValue {
  let total = 0;
  let fromBrickLink = 0;
  let fromFile = 0;
  let none = 0;
  for (const value of values) {
    if (value === null) {
      none += 1;
      continue;
    }
    if (value.source === 'bricklink') fromBrickLink += 1;
    else fromFile += 1;
    total += Math.round(value.amount * 100);
  }
  return { amount: fromBrickLink + fromFile === 0 ? null : total / 100, currency, fromBrickLink, fromFile, none };
}

/** A lot as `loadPartsLots` answers it: its own fields and its value. */
export interface PartsLotRow extends ValuedPartsLot {
  readonly id: string;
  readonly value: PartsLotValue | null;
}

/** The last import: its id and the file's currency, or null when nothing is imported. */
async function lastImport(db: ValuesDatabase): Promise<{ readonly id: string; readonly currency: string | null } | null> {
  const [last] = await db.select({ id: partsImport.id, currency: partsImport.currency }).from(partsImport).orderBy(desc(partsImport.importedAt)).limit(1);
  return last ?? null;
}

const LOT_COLUMNS = {
  id: partsLot.id,
  itemType: partsLot.itemType,
  itemNo: partsLot.itemNo,
  colorId: partsLot.colorId,
  lotCondition: partsLot.lotCondition,
  lotQuantity: partsLot.lotQuantity,
  unitPrice: partsLot.unitPrice,
};

const QUOTE_COLUMNS = {
  itemType: partPriceQuote.itemType,
  itemNo: partPriceQuote.itemNo,
  colorId: partPriceQuote.colorId,
  newOrUsed: partPriceQuote.newOrUsed,
  average: partPriceQuote.average,
  currency: partPriceQuote.currency,
  fetchedAt: partPriceQuote.fetchedAt,
};

/** The lots' order, the parts download's: by item type, number, colour and condition. */
const LOT_ORDER = [asc(partsLot.itemType), asc(partsLot.itemNo), asc(partsLot.colorId), asc(partsLot.lotCondition), asc(partsLot.id)] as const;

function asLot(row: { id: string; itemType: string; itemNo: string; colorId: number; lotCondition: 'N' | 'U'; lotQuantity: number; unitPrice: number | string | null }): Omit<PartsLotRow, 'value'> {
  return { ...row, unitPrice: row.unitPrice === null ? null : Number(row.unitPrice) };
}

function quotesByKey(rows: readonly { itemType: StoredPartQuote['itemType']; itemNo: string; colorId: number; newOrUsed: 'N' | 'U'; average: number | string | null; currency: string; fetchedAt: Date | null }[]): Map<string, StoredPartQuote> {
  const quotes = new Map<string, StoredPartQuote>();
  for (const row of rows) quotes.set(partQuoteKeyString(row), { ...row, average: row.average === null ? null : Number(row.average) });
  return quotes;
}

function valued(lots: readonly Omit<PartsLotRow, 'value'>[], quotes: ReadonlyMap<string, StoredPartQuote>, fileCurrency: string | null, currency: string): PartsLotRow[] {
  return lots.map((lot) => {
    const key = partQuoteKeyOf(lot);
    return { ...lot, value: partsLotValue(lot, key === null ? null : (quotes.get(partQuoteKeyString(key)) ?? null), fileCurrency, currency) };
  });
}

/**
 * Every lot of the last import with its value ([VAL-6]), or null when nothing is imported. The
 * lots and the stored part quotes are each read in pages, and joined here by their key.
 */
export async function loadPartsLots(db: ValuesDatabase, currency: string = deploymentCurrency()): Promise<{ readonly currency: string | null; readonly lots: readonly PartsLotRow[] } | null> {
  const last = await lastImport(db);
  if (last === null) return null;
  const lots: Omit<PartsLotRow, 'value'>[] = [];
  for (let offset = 0; ; offset += LOT_PAGE) {
    const page = await db.select(LOT_COLUMNS).from(partsLot).where(eq(partsLot.importId, last.id)).orderBy(...LOT_ORDER).limit(LOT_PAGE).offset(offset);
    lots.push(...page.map(asLot));
    if (page.length < LOT_PAGE) break;
  }
  const rows: Parameters<typeof quotesByKey>[0][number][] = [];
  for (let offset = 0; ; offset += LOT_PAGE) {
    const page = await db.select(QUOTE_COLUMNS).from(partPriceQuote).orderBy(asc(partPriceQuote.id)).limit(LOT_PAGE).offset(offset);
    rows.push(...page);
    if (page.length < LOT_PAGE) break;
  }
  return { currency: last.currency, lots: valued(lots, quotesByKey(rows), last.currency, currency) };
}

/** How many lots `/admin/parts` lists to a page ([VAL-11]). */
export const PARTS_PAGE_SIZE = 100;

/** One page of the lots, with their values, and the loose parts' value by source ([VAL-11]). */
export interface PartsLotsPage {
  /** The page shown, from 1; a page past the last shows the last. */
  readonly page: number;
  readonly pages: number;
  /** Every lot of the import. */
  readonly count: number;
  readonly lots: readonly PartsLotRow[];
  readonly value: PartsValue;
  /** The file's currency, the unit prices' own; null when it named none. */
  readonly fileCurrency: string | null;
}

/**
 * The lots of one page of `/admin/parts` with their values, and the parts' value by source, or
 * null when nothing is imported. The total needs every lot's value, so this values them all
 * (`loadPartsLots`) and slices the page from them, in the download's order.
 */
export async function loadPartsLotsPage(db: ValuesDatabase, page: number, currency: string = deploymentCurrency()): Promise<PartsLotsPage | null> {
  const loaded = await loadPartsLots(db, currency);
  if (loaded === null) return null;
  const pages = Math.max(1, Math.ceil(loaded.lots.length / PARTS_PAGE_SIZE));
  const shown = Math.min(Math.max(1, Math.trunc(page)), pages);
  return {
    page: shown,
    pages,
    count: loaded.lots.length,
    lots: loaded.lots.slice((shown - 1) * PARTS_PAGE_SIZE, shown * PARTS_PAGE_SIZE),
    value: partsValue(loaded.lots.map((lot) => lot.value), currency),
    fileCurrency: loaded.currency,
  };
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
