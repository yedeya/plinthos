import { describe, expect, it } from 'vitest';
import { CONDITIONS, KINDS, type Condition, type Kind } from '../../../src/db/schema/collection-item';
import {
  collectionTotals,
  deploymentCurrency,
  itemValue,
  lotCents,
  NO_ADJUSTMENTS,
  partsLotValue,
  partsValue,
  bricklinkSetNo,
  quoteKeyOf,
  segmentOf,
  type ItemValue,
  type StoredPartQuote,
  type StoredQuote,
  type ValuedItem,
  type ValuedPartsLot,
} from '../../../src/server/valuation/values';

/**
 * The pure value model (brief #207, Issue B, [VAL-5], [VAL-7]): `itemValue` for every kind and
 * condition, with and without an override and an adjustment, and `collectionTotals` by segment.
 * Every number here is made up.
 */

const AS_OF = new Date('2026-11-02T08:00:00.000Z');

function anItem(kind: Kind, condition: Condition, fields: Partial<ValuedItem> = {}): ValuedItem {
  return {
    id: `${kind}-${condition}`,
    kind,
    condition,
    quantity: 2,
    setNum: kind === 'SET' ? '990001-1' : null,
    refNo: kind === 'SET' ? null : 'mu0001',
    manualValueOverride: null,
    manualValueCurrency: null,
    ...fields,
  };
}

function quoteFor(item: ValuedItem, average: number | null = 50): StoredQuote | null {
  const key = quoteKeyOf(item);
  return key === null ? null : { ...key, average, currency: 'EUR', fetchedAt: AS_OF };
}

const ADJUSTED = { usedWithBoxPct: -10, usedNoBoxPct: 20 };

describe('itemValue', () => {
  it('[VAL-5] prices a set and a numbered minifigure by condition × quantity, adjusted for a used condition only', () => {
    const expected: Record<Condition, number> = { SEALED: 100, USED_WITH_BOX: 90, USED_NO_BOX: 120 };
    for (const kind of ['SET', 'MINIFIG'] as const) {
      for (const condition of CONDITIONS) {
        const item = anItem(kind, condition);
        expect(quoteKeyOf(item)).toMatchObject({ itemType: kind, newOrUsed: condition === 'SEALED' ? 'N' : 'U' });
        expect(itemValue(item, quoteFor(item), NO_ADJUSTMENTS, 'EUR'), `${kind} ${condition}`).toEqual({ amount: 100, currency: 'EUR', source: 'bricklink', asOf: AS_OF.toISOString() });
        expect(itemValue(item, quoteFor(item), ADJUSTED, 'EUR')?.amount, `${kind} ${condition}`).toBe(expected[condition]);
      }
    }
  });

  it('[VAL-5] gives a bulk lot, an OTHER item and a minifigure without a reference number a value only from an override', () => {
    for (const condition of CONDITIONS) {
      for (const item of [anItem('BULK', condition), anItem('OTHER', condition), anItem('MINIFIG', condition, { refNo: null })]) {
        expect(quoteKeyOf(item)).toBeNull();
        expect(itemValue(item, null, ADJUSTED, 'EUR')).toBeNull();
        // Even a quote for its reference number does not price it.
        expect(itemValue(item, { itemType: 'MINIFIG', itemNo: 'mu0001', newOrUsed: 'U', average: 9, currency: 'EUR', fetchedAt: AS_OF }, ADJUSTED, 'EUR')).toBeNull();
        expect(itemValue({ ...item, manualValueOverride: 30, manualValueCurrency: 'EUR' }, null, ADJUSTED, 'EUR')).toEqual({ amount: 30, currency: 'EUR', source: 'override', asOf: null });
      }
    }
  });

  it('[VAL-5] an override wins over the quote, is the whole item’s value, never adjusted, in its own currency', () => {
    for (const kind of KINDS) {
      const item = anItem(kind, 'USED_NO_BOX', { manualValueOverride: 75.5, manualValueCurrency: 'CHF' });
      expect(itemValue(item, quoteFor(item), ADJUSTED, 'EUR')).toEqual({ amount: 75.5, currency: 'CHF', source: 'override', asOf: null });
    }
    // An override stored without a currency is in the deployment's.
    expect(itemValue(anItem('SET', 'SEALED', { manualValueOverride: 1 }), null, NO_ADJUSTMENTS, 'GBP')?.currency).toBe('GBP');
  });

  it('[VAL-5] no quote, a quote with no sales, one never fetched, or one for another key give no value', () => {
    const item = anItem('SET', 'SEALED');
    expect(itemValue(item, null, NO_ADJUSTMENTS)).toBeNull();
    expect(itemValue(item, quoteFor(item, null), NO_ADJUSTMENTS)).toBeNull();
    expect(itemValue(item, { ...(quoteFor(item) as StoredQuote), fetchedAt: null }, NO_ADJUSTMENTS)).toBeNull();
    expect(itemValue(item, { ...(quoteFor(item) as StoredQuote), newOrUsed: 'U' }, NO_ADJUSTMENTS)).toBeNull();
  });

  it('[VAL-5] rounds to the cent, and -100 % values a used item at nothing', () => {
    const item = anItem('SET', 'USED_WITH_BOX', { quantity: 3 });
    expect(itemValue(item, quoteFor(item, 3.333), NO_ADJUSTMENTS)?.amount).toBe(10);
    expect(itemValue(item, quoteFor(item, 10), { usedWithBoxPct: -100, usedNoBoxPct: 0 })?.amount).toBe(0);
  });

  it('[VAL-2] reads the deployment’s currency, EUR by default', () => {
    expect(deploymentCurrency({})).toBe('EUR');
    expect(deploymentCurrency({ PLINTHOS_CURRENCY: ' usd ' })).toBe('USD');
    expect(deploymentCurrency({ PLINTHOS_CURRENCY: 'euro' })).toBe('EUR');
  });
});

describe('collectionTotals', () => {
  it('[VAL-7] sealed is sealed sets and OTHER items, used is used sets, every minifigure and used OTHER items, parts is the import and every bulk lot', () => {
    expect(segmentOf({ kind: 'SET', condition: 'SEALED' })).toBe('sealed');
    expect(segmentOf({ kind: 'SET', condition: 'USED_WITH_BOX' })).toBe('used');
    expect(segmentOf({ kind: 'SET', condition: 'USED_NO_BOX' })).toBe('used');
    for (const condition of CONDITIONS) {
      expect(segmentOf({ kind: 'MINIFIG', condition })).toBe('used');
      expect(segmentOf({ kind: 'BULK', condition })).toBe('parts');
      expect(segmentOf({ kind: 'OTHER', condition })).toBe(condition === 'SEALED' ? 'sealed' : 'used');
    }
  });

  it('[VAL-6] [VAL-7] totals each segment per currency, counts the unvalued, and adds the parts’ value to parts', () => {
    const items = [
      { id: 'a', kind: 'SET', condition: 'SEALED' },
      { id: 'b', kind: 'SET', condition: 'SEALED' },
      { id: 'c', kind: 'SET', condition: 'USED_NO_BOX' },
      { id: 'd', kind: 'MINIFIG', condition: 'SEALED' },
      { id: 'e', kind: 'BULK', condition: 'USED_NO_BOX' },
      { id: 'f', kind: 'BULK', condition: 'USED_NO_BOX' },
      { id: 'g', kind: 'OTHER', condition: 'USED_WITH_BOX' },
    ] as const;
    const value = (amount: number, currency = 'EUR') => ({ amount, currency, source: 'bricklink' as const, asOf: AS_OF.toISOString() });
    const values = new Map<string, ItemValue | null>([
      ['a', value(100.1)],
      ['b', value(0.2)],
      ['c', value(40)],
      ['d', value(5, 'USD')],
      ['e', { amount: 20, currency: 'EUR', source: 'override' as const, asOf: null }],
      ['f', null],
    ]);
    const totals = collectionTotals(items, values, { amount: 12.5, currency: 'USD' });
    expect(totals.sealed).toEqual({ amounts: [{ currency: 'EUR', amount: 100.3 }], valued: 2, unvalued: 0 });
    expect(totals.used).toEqual({ amounts: [{ currency: 'EUR', amount: 40 }, { currency: 'USD', amount: 5 }], valued: 2, unvalued: 1 });
    expect(totals.parts).toEqual({ amounts: [{ currency: 'EUR', amount: 20 }, { currency: 'USD', amount: 12.5 }], valued: 2, unvalued: 1 });
    expect(totals.all).toEqual({ amounts: [{ currency: 'EUR', amount: 160.3 }, { currency: 'USD', amount: 17.5 }], valued: 6, unvalued: 2 });
    expect(collectionTotals([], new Map(), null).all).toEqual({ amounts: [], valued: 0, unvalued: 0 });
    // Loose parts with no lot valued add nothing.
    expect(collectionTotals([], new Map(), { amount: null, currency: 'EUR' }).parts).toEqual({ amounts: [], valued: 0, unvalued: 0 });
  });
});

describe('a parts lot’s value', () => {
  const lot = (fields: Partial<ValuedPartsLot> = {}): ValuedPartsLot => ({ itemType: 'P', itemNo: '3001', colorId: 5, lotCondition: 'U', lotQuantity: 4, unitPrice: 0.125, ...fields });
  const quote = (fields: Partial<StoredPartQuote> = {}): StoredPartQuote => ({ itemType: 'PART', itemNo: '3001', colorId: 5, newOrUsed: 'U', average: 0.333, currency: 'EUR', fetchedAt: AS_OF, ...fields });

  it('[VAL-6] is BrickLink’s average × quantity when the lot’s quote has one, with its date', () => {
    expect(partsLotValue(lot(), quote(), 'EUR', 'EUR')).toEqual({ amount: 1.33, unitPrice: 0.333, source: 'bricklink', asOf: AS_OF.toISOString() });
    // A minifigure's quote has no colour ([VAL-8]): the lot's colour is not part of its key.
    expect(partsLotValue(lot({ itemType: 'M', itemNo: 'mu0001', colorId: 9 }), quote({ itemType: 'MINIFIG', itemNo: 'mu0001', colorId: 0 }), null, 'EUR')).toMatchObject({ source: 'bricklink' });
  });

  it('[VAL-6] falls back to the file’s price × quantity when the quote has no average, is another lot’s, or is in another currency', () => {
    const file = { amount: 0.5, unitPrice: 0.125, source: 'file', asOf: null };
    expect(partsLotValue(lot(), quote({ average: null }), 'EUR', 'EUR')).toEqual(file);
    expect(partsLotValue(lot(), quote({ fetchedAt: null }), 'EUR', 'EUR')).toEqual(file);
    expect(partsLotValue(lot(), quote({ colorId: 6 }), 'EUR', 'EUR')).toEqual(file);
    expect(partsLotValue(lot(), quote({ newOrUsed: 'N' }), 'EUR', 'EUR')).toEqual(file);
    expect(partsLotValue(lot(), quote({ currency: 'USD' }), 'EUR', 'EUR')).toEqual(file);
    expect(partsLotValue(lot(), null, 'EUR', 'EUR')).toEqual(file);
    // A file that names no currency is taken to be in the deployment's.
    expect(partsLotValue(lot(), null, null, 'EUR')).toEqual(file);
    // A type BrickLink doesn't price has only the file's price.
    expect(partsLotValue(lot({ itemType: 'X' }), quote(), 'EUR', 'EUR')).toEqual(file);
  });

  it('[VAL-6] has none with no BrickLink average and no file price in the deployment’s currency', () => {
    expect(partsLotValue(lot({ unitPrice: null }), null, 'EUR', 'EUR')).toBeNull();
    expect(partsLotValue(lot(), null, 'USD', 'EUR')).toBeNull();
    expect(partsLotValue(lot(), quote({ average: null }), 'USD', 'EUR')).toBeNull();
  });

  it('[VAL-6] rounds each lot to the cent once, half up, with no float error', () => {
    // 1.005 × 1 is 100.49999… cents in floating point; in thousandths it is exactly 100.5.
    expect(lotCents(1.005, 1)).toBe(101);
    expect(lotCents(0.125, 3)).toBe(38);
    expect(lotCents(0.001, 4)).toBe(0);
    expect(lotCents(0.001, 5)).toBe(1);
    expect(lotCents(1_000_000, 1_000_000)).toBe(100_000_000_000_000);
  });

  it('[VAL-6] totals the lots with a value in the deployment’s currency, exactly, with the lots per source', () => {
    const at = (amount: number, source: 'bricklink' | 'file') => ({ amount, unitPrice: amount, source, asOf: source === 'bricklink' ? AS_OF.toISOString() : null });
    // 0.1 + 0.2 is not 0.3 in floating point; the sum of cents is.
    expect(partsValue([at(0.1, 'bricklink'), at(0.2, 'file'), null, at(1.01, 'bricklink'), null], 'EUR')).toEqual({ amount: 1.31, currency: 'EUR', fromBrickLink: 2, fromFile: 1, none: 2 });
    expect(partsValue([null, null], 'EUR')).toEqual({ amount: null, currency: 'EUR', fromBrickLink: 0, fromFile: 0, none: 2 });
    expect(partsValue([], 'USD')).toEqual({ amount: null, currency: 'USD', fromBrickLink: 0, fromFile: 0, none: 0 });
  });
});

describe('BrickLink\'s set numbers', () => {
  it('[VAL-2] keeps a set\'s number as it is, outside the numbered series of collectible minifigures', () => {
    expect(bricklinkSetNo('990001-1', 'Made-up')).toBe('990001-1');
    expect(bricklinkSetNo('990001-1', null)).toBe('990001-1');
    expect(bricklinkSetNo('990001-1', undefined)).toBe('990001-1');
    // A themed series isn't numbered alike: its number is kept, and BrickLink answers for it or not.
    expect(bricklinkSetNo('990012-3', 'Made-up Studios Series')).toBe('990012-3');
  });

  it('[VAL-2] numbers a numbered series\' figure col<series>-<n> and its random bag <box>-1, as BrickLink does', () => {
    expect(bricklinkSetNo('990029-12', 'Series 21 Minifigures')).toBe('col21-12');
    expect(bricklinkSetNo('990029-2', 'Series 21 Minifigures')).toBe('col21-2');
    expect(bricklinkSetNo('990001-3', 'Series 1 Minifigures')).toBe('col01-3');
    expect(bricklinkSetNo('990029-0', 'Series 21 Minifigures')).toBe('990029-1');
    // Never Rebrickable's own number, under which BrickLink holds other things.
    expect(bricklinkSetNo('990029-1', 'Series 21 Minifigures')).toBe('col21-1');
    // A number that isn't <box>-<n> isn't asked for at all.
    expect(bricklinkSetNo('990029', 'Series 21 Minifigures')).toBeNull();
    expect(bricklinkSetNo('990029-1b', 'Series 21 Minifigures')).toBeNull();
  });

  it('[VAL-2] a set in a numbered series is quoted by BrickLink\'s number, and one BrickLink can\'t be asked for has none', () => {
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '990029-12', theme: 'Series 21 Minifigures' }))).toEqual({ itemType: 'SET', itemNo: 'col21-12', newOrUsed: 'N' });
    expect(quoteKeyOf(anItem('SET', 'USED_NO_BOX', { setNum: '990029-0', theme: 'Series 21 Minifigures' }))).toEqual({ itemType: 'SET', itemNo: '990029-1', newOrUsed: 'U' });
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '990029', theme: 'Series 21 Minifigures' }))).toBeNull();
  });
});

