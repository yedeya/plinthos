import { describe, expect, it } from 'vitest';
import { CONDITIONS, KINDS, type Condition, type Kind } from '../../../src/db/schema/collection-item';
import {
  collectionTotals,
  deploymentCurrency,
  itemValue,
  lotCents,
  MINIFIGURE_SERIES,
  NO_ADJUSTMENTS,
  partsLotValue,
  partsValue,
  bricklinkSetNo,
  COLLECTIBLE_MINIFIGURES_THEME,
  quoteKeyOf,
  unlistedSeriesBox,
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
  // The box numbers are the series' public catalogue numbers, which the mapping is keyed on; no
  // collection's data is in them.
  it('[VAL-2] keeps the number of a set whose box isn\'t a series of collectible minifigures', () => {
    expect(bricklinkSetNo('10179-1')).toBe('10179-1');
    expect(bricklinkSetNo('990001-1')).toBe('990001-1');
    expect(bricklinkSetNo('990001')).toBe('990001');
    // A series' sealed box and 6-pack have numbers of their own, and keep them.
    expect(bricklinkSetNo('66657-1')).toBe('66657-1');
    expect(bricklinkSetNo('6341811-1')).toBe('6341811-1');
    // A box number that merely contains a listed one isn't it.
    expect(bricklinkSetNo('710290-1')).toBe('710290-1');
    expect(bricklinkSetNo('171029-1')).toBe('171029-1');
  });

  it('[VAL-2] numbers a figure <prefix>-<n>, the random bag <box>-1 and the complete series <box>-2', () => {
    expect(bricklinkSetNo('71029-1')).toBe('col21-1');
    expect(bricklinkSetNo('71029-12')).toBe('col21-12');
    expect(bricklinkSetNo('71029-0')).toBe('71029-1');
    expect(bricklinkSetNo('71029-13')).toBe('71029-2');
    expect(bricklinkSetNo('8683-3')).toBe('col01-3');
    expect(bricklinkSetNo('8683-17')).toBe('8683-2');
    expect(bricklinkSetNo('71021-17')).toBe('col18-17');
    expect(bricklinkSetNo('71021-18')).toBe('71021-2');
    expect(bricklinkSetNo('71038-18')).toBe('coldis100-18');
    expect(bricklinkSetNo('71038-19')).toBe('71038-2');
    expect(bricklinkSetNo('71017-20')).toBe('coltlbm-20');
    expect(bricklinkSetNo('71017-21')).toBe('71017-2');
    expect(bricklinkSetNo('71019-1')).toBe('coltlnm-1');
    expect(bricklinkSetNo('71022-22')).toBe('colhp-22');
    expect(bricklinkSetNo('71022-23')).toBe('71022-2');
  });

  it('[VAL-2] has no number for a listed box\'s other entries, nor for a malformed number in one', () => {
    // After the complete series: a sealed box or a tower box, which BrickLink has no number for.
    expect(bricklinkSetNo('71030-14')).toBeNull();
    expect(bricklinkSetNo('71029-14')).toBeNull();
    expect(bricklinkSetNo('8803-18')).toBeNull();
    for (const setNum of ['71029', '71029-', '71029-1b', '71029-01', '71029--1', '71029-1-2', '71029-x']) expect(bricklinkSetNo(setNum), setNum).toBeNull();
  });

  it('[VAL-2] numbers Series 10\'s Mr. Gold col10-17, after its sixteen figures', () => {
    expect(bricklinkSetNo('71001-1')).toBe('col10-1');
    expect(bricklinkSetNo('71001-16')).toBe('col10-16');
    expect(bricklinkSetNo('71001-19')).toBe('col10-17');
    expect(bricklinkSetNo('71001-17')).toBe('71001-2');
    expect(bricklinkSetNo('71001-18')).toBeNull();
    expect(bricklinkSetNo('71001-0')).toBe('71001-1');
  });

  it('[VAL-2] asks for no figure of a box BrickLink files without a figure prefix, but for its random bag and complete series', () => {
    expect(bricklinkSetNo('8909-3')).toBeNull();
    expect(bricklinkSetNo('8909-9')).toBeNull();
    expect(bricklinkSetNo('8909-10')).toBeNull();
    expect(bricklinkSetNo('8909-0')).toBe('8909-1');
    expect(bricklinkSetNo('8909-17')).toBe('8909-2');
    expect(bricklinkSetNo('71049-12')).toBeNull();
    expect(bricklinkSetNo('71049-0')).toBe('71049-1');
    expect(bricklinkSetNo('71049-13')).toBe('71049-2');
  });

  it('[VAL-2] lists each box once, with a prefix of its own and its complete series after its figures', () => {
    const boxes = MINIFIGURE_SERIES.map((row) => row.box);
    expect(new Set(boxes).size).toBe(boxes.length);
    const prefixes = MINIFIGURE_SERIES.flatMap((row) => (row.prefix === null ? [] : [row.prefix]));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const row of MINIFIGURE_SERIES) {
      expect(row.box, row.name).toMatch(/^\d+$/);
      expect(row.figures, row.name).toBeGreaterThan(0);
      expect(row.complete, row.name).toBeGreaterThan(row.figures);
      if (row.prefix !== null) expect(row.prefix, row.name).toMatch(/^col[a-z0-9]+$/);
      // A renumbered figure lies past the figures, isn't the complete series, and lands after the figures.
      for (const [from, to] of Object.entries(row.renumbered ?? {})) {
        expect(Number(from), row.name).toBeGreaterThan(row.figures);
        expect(Number(from), row.name).not.toBe(row.complete);
        expect(to, row.name).toBeGreaterThan(row.figures);
      }
    }
  });

  it('[VAL-2] has no number for a series the table doesn\'t list yet, under the Collectible Minifigures theme, but for <box>-1', () => {
    // 99071 is a made-up box of a series released after the table was last updated (#250).
    const cmf = COLLECTIBLE_MINIFIGURES_THEME;
    expect(cmf).toBe('Collectible Minifigures');
    for (const setNum of ['99071-0', '99071-2', '99071-12', '99071-13', '99071', '99071-x']) {
      expect(bricklinkSetNo(setNum, cmf), setNum).toBeNull();
      expect(unlistedSeriesBox(setNum, cmf), setNum).toBe('99071');
    }
    // <box>-1 is a sealed box's or a 6-pack's own number as often as a first figure, and is kept.
    expect(bricklinkSetNo('99071-1', cmf)).toBe('99071-1');
    expect(bricklinkSetNo('66657-1', cmf)).toBe('66657-1');
    expect(bricklinkSetNo('6341811-1', cmf)).toBe('6341811-1');
    expect(unlistedSeriesBox('6341811-1', cmf)).toBeNull();
    // A listed box maps as before, under the theme or with none stored.
    expect(bricklinkSetNo('71029-12', cmf)).toBe('col21-12');
    expect(bricklinkSetNo('71029-0', cmf)).toBe('71029-1');
    expect(unlistedSeriesBox('71029-12', cmf)).toBeNull();
    // Under another top-level theme, with none stored, or with a near name, a number is kept.
    for (const theme of [null, undefined, 'Made-up ninjas', 'collectible minifigures', 'Series 30 Minifigures']) {
      expect(bricklinkSetNo('99071-2', theme ?? null), String(theme)).toBe('99071-2');
      expect(unlistedSeriesBox('99071-2', theme), String(theme)).toBeNull();
    }
    expect(bricklinkSetNo('99071-2')).toBe('99071-2');
  });

  it('[VAL-2] quotes an item by its set\'s top-level theme, and gives a series the table doesn\'t list no quote', () => {
    const cmf = COLLECTIBLE_MINIFIGURES_THEME;
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '99071-2', topTheme: cmf }))).toBeNull();
    expect(quoteKeyOf(anItem('SET', 'USED_NO_BOX', { setNum: '99071-0', topTheme: cmf }))).toBeNull();
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '99071-1', topTheme: cmf }))).toEqual({ itemType: 'SET', itemNo: '99071-1', newOrUsed: 'N' });
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '99071-2', topTheme: null }))).toEqual({ itemType: 'SET', itemNo: '99071-2', newOrUsed: 'N' });
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '99071-2' }))).toEqual({ itemType: 'SET', itemNo: '99071-2', newOrUsed: 'N' });
    // No quote, so no value but an override.
    const unlisted = anItem('SET', 'SEALED', { setNum: '99071-2', topTheme: cmf });
    expect(itemValue(unlisted, { itemType: 'SET', itemNo: '99071-2', newOrUsed: 'N', average: 90, currency: 'EUR', fetchedAt: AS_OF }, NO_ADJUSTMENTS)).toBeNull();
    expect(itemValue({ ...unlisted, manualValueOverride: 4, manualValueCurrency: 'EUR' }, null, NO_ADJUSTMENTS)).toMatchObject({ amount: 4, source: 'override' });
  });

  it('[VAL-2] a set is quoted by BrickLink\'s number, and one BrickLink has no number for has no quote', () => {
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '71029-12' }))).toEqual({ itemType: 'SET', itemNo: 'col21-12', newOrUsed: 'N' });
    expect(quoteKeyOf(anItem('SET', 'USED_NO_BOX', { setNum: '71029-0' }))).toEqual({ itemType: 'SET', itemNo: '71029-1', newOrUsed: 'U' });
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '71029-13' }))).toEqual({ itemType: 'SET', itemNo: '71029-2', newOrUsed: 'N' });
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '66657-1' }))).toEqual({ itemType: 'SET', itemNo: '66657-1', newOrUsed: 'N' });
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '71030-14' }))).toBeNull();
    expect(quoteKeyOf(anItem('SET', 'SEALED', { setNum: '71029' }))).toBeNull();
  });
});

