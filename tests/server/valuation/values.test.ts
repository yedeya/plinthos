import { describe, expect, it } from 'vitest';
import { CONDITIONS, KINDS, type Condition, type Kind } from '../../../src/db/schema/collection-item';
import {
  collectionTotals,
  deploymentCurrency,
  itemValue,
  NO_ADJUSTMENTS,
  quoteKeyOf,
  segmentOf,
  type ItemValue,
  type StoredQuote,
  type ValuedItem,
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
  });
});
