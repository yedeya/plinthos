// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemList } from '../../src/app/_admin/item-list';
import { ValueAdjustmentsForm } from '../../src/app/_admin/settings-forms';
import { checkAdjustments, parseOverride, type RefreshPricesInput, type RefreshPricesResult } from '../../src/app/_admin/value-data';
import { MAX_REFRESH_CALLS, RefreshOutcomeText, RefreshPrices, runRefresh, ValueTotals, valueText } from '../../src/app/_admin/values';
import type { ListedItem } from '../../src/app/_offline/items';

/**
 * The values on the admin's pages (brief #207, Issue B, [VAL-3], [VAL-4], [VAL-7]): the Refresh
 * prices loop against a fake action, the outcomes it shows, each item's value with its source and
 * date, the totals, and the checks of the override and the adjustments. Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = '2026-11-03T10:00:00.000Z';

/** A fake action that answers the given results in turn, and records what it was called with. */
function fakeAction(results: readonly (RefreshPricesResult | Error)[]) {
  const calls: RefreshPricesInput[] = [];
  const action = vi.fn(async (input: RefreshPricesInput) => {
    calls.push(input);
    const next = results[calls.length - 1];
    if (next === undefined) throw new Error('called once too often');
    if (next instanceof Error) throw next;
    return next;
  });
  return { action, calls };
}

describe('the Refresh prices loop', () => {
  it('[VAL-3] calls again with the run’s start until nothing is left, and reports the progress', async () => {
    const { action, calls } = fakeAction([
      { done: 3, failed: 1, left: 5, runStartedAt: RUN },
      { done: 4, failed: 0, left: 1, runStartedAt: RUN },
      { done: 1, failed: 0, left: 0, runStartedAt: RUN },
    ]);
    const progress: string[] = [];
    const outcome = await runRefresh(action, false, (done, left) => progress.push(`${done}/${left}`));
    expect(outcome).toEqual({ kind: 'done', done: 8, failed: 1 });
    expect(calls).toEqual([{ all: false }, { all: false, runStartedAt: RUN }, { all: false, runStartedAt: RUN }]);
    expect(progress).toEqual(['4/5', '8/1', '9/0']);
  });

  it('[VAL-4] stops at the first call that stopped, failed on the server, or made no progress', async () => {
    const stopped = fakeAction([
      { done: 2, failed: 0, left: 3, runStartedAt: RUN },
      { done: 0, failed: 0, left: 3, stopped: 'refused-key', runStartedAt: RUN },
    ]);
    expect(await runRefresh(stopped.action, true)).toEqual({ kind: 'stopped', reason: 'refused-key', done: 2, failed: 0, left: 3 });
    expect(stopped.calls[0]).toEqual({ all: true });
    expect(await runRefresh(fakeAction([new Error('made-up failure')]).action, false)).toEqual({ kind: 'failed', done: 0, failed: 0 });
    expect(await runRefresh(fakeAction([{ done: 0, failed: 0, left: 2, runStartedAt: RUN }]).action, false)).toEqual({ kind: 'stalled', done: 0, failed: 0 });
    // A run never calls more than MAX_REFRESH_CALLS times.
    const endless = vi.fn(async () => ({ done: 1, failed: 0, left: 1, runStartedAt: RUN }));
    expect(await runRefresh(endless, false)).toMatchObject({ kind: 'stalled' });
    expect(endless).toHaveBeenCalledTimes(MAX_REFRESH_CALLS);
  });

  it('[VAL-4] says how a refresh ended, and that the old prices are kept when it stopped', () => {
    const say = (outcome: Parameters<typeof RefreshOutcomeText>[0]['outcome']) => renderToStaticMarkup(createElement(RefreshOutcomeText, { outcome }));
    expect(say({ kind: 'done', done: 0, failed: 0 })).toContain('Every price is up to date.');
    expect(say({ kind: 'done', done: 4, failed: 1 })).toContain('4 fetched, 1 without a price');
    const refused = say({ kind: 'stopped', reason: 'refused-key', done: 2, failed: 0, left: 3 });
    expect(refused).toContain('role="alert"');
    expect(refused).toContain('BrickLink refused the keys');
    expect(refused).toContain('Every price you had is kept.');
    expect(say({ kind: 'stopped', reason: 'unreachable', done: 0, failed: 3, left: 2 })).toContain('BrickLink is not answering');
    expect(say({ kind: 'stopped', reason: 'rate-limited', done: 0, failed: 0, left: 2 })).toContain('request limit');
    expect(say({ kind: 'failed', done: 0, failed: 0 })).toContain('Every price you had is kept.');
  });
});

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

  it('[VAL-3] [VAL-4] runs the loop on a press and shows a stop on the page', async () => {
    const { action, calls } = fakeAction([
      { done: 0, failed: 0, left: 2, stopped: 'refused-key', runStartedAt: RUN },
    ]);
    await act(async () => root.render(createElement(RefreshPrices, { action })));
    const [refresh, all] = [...container.querySelectorAll('button')];
    await act(async () => refresh?.click());
    for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    expect(calls).toEqual([{ all: false }]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('BrickLink refused the keys');
    expect(all?.textContent).toBe('Refresh every price');
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
