// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemList } from '../../src/app/_admin/item-list';
import { ValueAdjustmentsForm } from '../../src/app/_admin/settings-forms';
import { checkAdjustments, parseOverride, type PriceRefreshRunView, type StartPriceRefreshInput, type StartPriceRefreshResult } from '../../src/app/_admin/value-data';
import { RefreshPrices, ValueTotals, valueText } from '../../src/app/_admin/values';
import type { ListedItem } from '../../src/app/_offline/items';

/**
 * The values on the admin's pages (brief #207, Issue B, [VAL-3], [VAL-7]; #226, [VAL-9]): the
 * Refresh prices button against a fake action, which starts the background job, and what it says;
 * each item's value with its source and date, the totals, and the checks of the override and the
 * adjustments. Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN_ID = '00000000-0000-4000-8000-000000000001';

/** A made-up run, as `startPriceRefresh` answers it. */
const RUN: PriceRefreshRunView = {
  id: RUN_ID,
  scope: 'items',
  all: false,
  state: 'running',
  stopReason: null,
  stopRequested: false,
  startedAt: '2026-11-03T10:00:00.000Z',
  heartbeatAt: '2026-11-03T10:00:00.000Z',
  finishedAt: null,
  done: 0,
  failed: 0,
  left: 0,
};

describe('the Refresh prices button', () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function press(answer: StartPriceRefreshResult | Error, which: 0 | 1 = 0) {
    const calls: StartPriceRefreshInput[] = [];
    const action = vi.fn(async (input: StartPriceRefreshInput) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    await act(async () => root.render(createElement(RefreshPrices, { action })));
    await act(async () => [...container.querySelectorAll('button')][which]?.click());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    return calls;
  }

  it('[VAL-3] [VAL-9] starts the background job for the sets and minifigures, once a press, and says the page may close', async () => {
    expect(await press({ status: 'started', run: RUN })).toEqual([{ scope: 'items', all: false }]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('You may close this page');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(await press({ status: 'started', run: { ...RUN, all: true } }, 1)).toEqual([{ scope: 'items', all: true }]);
    expect([...container.querySelectorAll('button')][1]?.textContent).toBe('Refresh every price');
  });

  it('[VAL-9] says when a refresh is already running, could not start, or failed on the server', async () => {
    await press({ status: 'busy', run: RUN });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already running');
    await act(async () => root.unmount());
    root = createRoot(container);
    await press({ status: 'not-started', run: { ...RUN, state: 'stopped', stopReason: 'invoke-failed' } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be started');
    await act(async () => root.unmount());
    root = createRoot(container);
    await press(new Error('made-up failure'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The refresh failed on the server.');
  });
});

describe('the values in the list', () => {
  it('[VAL-7] shows each item’s value with its source and date, and no value as such', () => {
    const items: ListedItem[] = [
      { id: randomUUID(), kind: 'SET', setNum: '990001-1', refNo: null, name: 'Made-up ferry', condition: 'SEALED', quantity: 1, stockImageUrl: null, coverThumbnailUrl: null, version: 1, value: { amount: 1234.5, currency: 'EUR', source: 'bricklink', asOf: '2026-11-02T08:00:00.000Z' } },
      { id: randomUUID(), kind: 'BULK', setNum: null, refNo: null, name: 'Made-up tub', condition: 'USED_NO_BOX', quantity: 1, stockImageUrl: null, coverThumbnailUrl: null, version: 1, value: { amount: 20, currency: 'EUR', source: 'override', asOf: null } },
      { id: randomUUID(), kind: 'OTHER', setNum: null, refNo: null, name: 'Made-up keychain', condition: 'USED_NO_BOX', quantity: 1, stockImageUrl: null, coverThumbnailUrl: null, version: 1, value: null },
    ];
    const html = renderToStaticMarkup(createElement(ItemList, { items }));
    expect(html).toContain('€1,234.50 · BrickLink, as of 2 Nov 2026');
    expect(html).toContain('€20.00 · your value');
    expect(html).toContain('No value');
    expect(valueText(undefined)).toBe('No value');
  });

  it('[VAL-7] shows the totals per segment, each currency apart, and how many have no value', () => {
    const none = { amounts: [], valued: 0, unvalued: 0 };
    const html = renderToStaticMarkup(
      createElement(ValueTotals, {
        totals: {
          sealed: { amounts: [{ currency: 'EUR', amount: 100 }], valued: 1, unvalued: 2 },
          used: none,
          parts: { amounts: [{ currency: 'EUR', amount: 5 }, { currency: 'USD', amount: 7.5 }], valued: 2, unvalued: 0 },
          all: { amounts: [{ currency: 'EUR', amount: 105 }, { currency: 'USD', amount: 7.5 }], valued: 3, unvalued: 2 },
        },
      }),
    );
    for (const text of ['Sealed', 'Used', 'Parts', 'Total', '€100.00', '2 without a value', '€5.00 + $7.50', 'Only you see these values.']) expect(html).toContain(text);
  });
});

describe('the override and the adjustments', () => {
  it('[VAL-7] reads the override the owner typed: blank is none, a decimal comma is taken, and a refusal says why', () => {
    expect(parseOverride('')).toBeNull();
    expect(parseOverride('  ')).toBeNull();
    expect(parseOverride('125')).toBe(125);
    expect(parseOverride('125.5')).toBe(125.5);
    expect(parseOverride('125,50')).toBe(125.5);
    expect(parseOverride('1,234.50')).toBe(1234.5);
    expect(parseOverride('1 234,5')).toBe(1234.5);
    expect(parseOverride('-5')).toBe('notANumber');
    expect(parseOverride('ten')).toBe('notANumber');
    expect(parseOverride('1e5')).toBe('notANumber');
    expect(parseOverride('12.345')).toBe('tooManyDecimals');
    expect(parseOverride('10000001')).toBe('tooLarge');
  });

  it('[VAL-5] checks the adjustments by the service’s schema: whole percentages from -100 to 100, blank is 0', () => {
    expect(checkAdjustments({ usedWithBoxPct: '-15', usedNoBoxPct: '' })).toEqual({ ok: true, input: { usedWithBoxPct: -15, usedNoBoxPct: 0 } });
    expect(checkAdjustments({ usedWithBoxPct: '101', usedNoBoxPct: '2.5' })).toEqual({ ok: false, result: { status: 'invalid', problems: { usedWithBoxPct: 'outOfRange', usedNoBoxPct: 'outOfRange' } } });
    const html = renderToStaticMarkup(createElement(ValueAdjustmentsForm, { action: async () => ({ status: 'saved' as const }), usedWithBoxPct: -10, usedNoBoxPct: 5, range: { min: -100, max: 100 } }));
    expect(html).toContain('name="usedWithBoxPct"');
    expect(html).toContain('value="-10"');
    expect(html).toContain('min="-100"');
  });
});
