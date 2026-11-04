// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemList } from '../../src/app/_admin/item-list';
import { ValueAdjustmentsForm } from '../../src/app/_admin/settings-forms';
import { PartsValues } from '../../src/app/_admin/parts-values';
import {
  checkAdjustments,
  parseOverride,
  parsePartsPage,
  type PartsLotRow,
  type PartsLotsPage,
  type PriceRefreshRunView,
  type PriceRefreshStatus,
  type StartPriceRefreshInput,
  type StartPriceRefreshResult,
  type StopPriceRefreshResult,
} from '../../src/app/_admin/value-data';
import { outcomeText, RefreshPrices, ValueTotals, valueText } from '../../src/app/_admin/values';
import { STOP_REASONS } from '../../src/db/schema/price-refresh-run';
import type { ListedItem } from '../../src/app/_offline/items';

/**
 * The values on the admin's pages (brief #207, Issue B, [VAL-3], [VAL-7]; #226, [VAL-9] to
 * [VAL-11]): Refresh prices against fake actions, which starts the background job, follows its
 * progress while the page is visible, stops it and shows how it ended; the parts' values on
 * `/admin/parts`;
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

/** The refresh as `/admin` renders it: a run, or none, and the day's calls. */
const STATUS = (run: PriceRefreshRunView | null, callsToday = 120): PriceRefreshStatus => ({ run, callsToday, dailyLimit: 4500 });

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
    Reflect.deleteProperty(document, 'visibilityState');
  });

  const settle = async (times = 3) => {
    for (let i = 0; i < times; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  };
  const button = (text: string) => [...container.querySelectorAll('button')].find((one) => one.textContent === text);

  function render(options: { start?: StartPriceRefreshResult | Error; stop?: StopPriceRefreshResult; status?: () => PriceRefreshStatus; initial?: PriceRefreshStatus } = {}) {
    const calls: StartPriceRefreshInput[] = [];
    const start = vi.fn(async (input: StartPriceRefreshInput) => {
      calls.push(input);
      const answer = options.start ?? { status: 'started', run: RUN };
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const stop = vi.fn(async (): Promise<StopPriceRefreshResult> => options.stop ?? { status: 'stopping', run: { ...RUN, stopRequested: true } });
    const status = vi.fn(async () => (options.status ?? (() => STATUS(RUN)))());
    return { calls, start, stop, status, mount: () => act(async () => root.render(createElement(RefreshPrices, { start, stop, status, initial: options.initial ?? STATUS(null), pollMs: 10 }))) };
  }

  it('[VAL-3] [VAL-9] [VAL-11] starts the background job for the scope chosen, once a press, and says the page may close', async () => {
    const view = render();
    await view.mount();
    expect([...container.querySelectorAll('input[type="radio"]')].map((one) => (one as HTMLInputElement).value)).toEqual(['items', 'parts', 'all']);
    await act(async () => button('Refresh prices')?.click());
    await settle();
    expect(view.calls).toEqual([{ scope: 'items', all: false }]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('You may close this page');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    const again = render({ start: { status: 'started', run: { ...RUN, scope: 'all', all: true } } });
    await again.mount();
    await act(async () => (container.querySelector('input[value="all"]') as HTMLInputElement).click());
    await act(async () => (container.querySelector('input[name="refreshAll"]') as HTMLInputElement).click());
    await act(async () => button('Refresh prices')?.click());
    await settle();
    expect(again.calls).toEqual([{ scope: 'all', all: true }]);
  });

  it('[VAL-9] says when a refresh is already running, could not start, or failed on the server', async () => {
    await render({ start: { status: 'busy', run: RUN } }).mount();
    await act(async () => button('Refresh prices')?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('already running');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ start: { status: 'not-started', run: { ...RUN, state: 'stopped', stopReason: 'invoke-failed', finishedAt: RUN.startedAt } } }).mount();
    await act(async () => button('Refresh prices')?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be started');
    expect(container.textContent).toContain('the refresh could not start');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ start: new Error('made-up failure') }).mount();
    await act(async () => button('Refresh prices')?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The refresh failed on the server.');
  });

  it('[VAL-11] shows a running run’s progress, polled while the page is visible and the run runs, then its outcome', async () => {
    let answer = STATUS({ ...RUN, done: 40, failed: 2, left: 58 }, 140);
    const view = render({ initial: STATUS({ ...RUN, done: 10, failed: 0, left: 90 }), status: () => answer });
    await view.mount();
    expect(container.textContent).toContain('10 done · 0 failed · 90 left');
    expect(container.textContent).toContain('BrickLink calls today (UTC): 120 of 4,500');
    expect(button('Refresh prices')?.disabled).toBe(true);
    expect(button('Stop')).toBeDefined();
    await settle();
    expect(view.status).toHaveBeenCalled();
    expect(container.textContent).toContain('40 done · 2 failed · 58 left');
    expect(container.textContent).toContain('BrickLink calls today (UTC): 140 of 4,500');
    // A hidden page asks for nothing.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    const asked = view.status.mock.calls.length;
    await settle(5);
    expect(view.status.mock.calls.length).toBe(asked);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    answer = STATUS({ ...RUN, state: 'done', done: 98, failed: 2, left: 0, finishedAt: '2026-11-03T10:30:00.000Z' }, 240);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(container.textContent).toContain('Done.');
    expect(container.textContent).toContain('98 done · 2 failed · 0 left');
    expect(button('Stop')).toBeUndefined();
    expect(button('Refresh prices')?.disabled).toBe(false);
    // An ended run is polled no more.
    const ended = view.status.mock.calls.length;
    await settle(5);
    expect(view.status.mock.calls.length).toBe(ended);
  });

  it('[VAL-11] Stop asks the running run to stop, and says it is stopping', async () => {
    const view = render({ initial: STATUS(RUN), status: () => STATUS({ ...RUN, stopRequested: true }) });
    await view.mount();
    await act(async () => button('Stop')?.click());
    await settle(1);
    expect(view.stop).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Stopping after the current request');
    expect(button('Stop')).toBeUndefined();
  });

  it('[VAL-10] [VAL-11] shows each way a run ends: done, stopped by the owner, with a reason, at the daily limit, or stalled', async () => {
    const ended = (state: 'done' | 'stopped', stopReason: PriceRefreshRunView['stopReason']) => {
      const html = renderToStaticMarkup(
        createElement(RefreshPrices, {
          start: async (): Promise<StartPriceRefreshResult> => ({ status: 'started', run: RUN }),
          stop: async (): Promise<StopPriceRefreshResult> => ({ status: 'not-running', run: null }),
          status: async () => STATUS(null),
          initial: STATUS({ ...RUN, state, stopReason, finishedAt: '2026-11-03T11:00:00.000Z' }),
        }),
      );
      return html;
    };
    expect(ended('done', null)).toContain('Done.');
    expect(ended('stopped', 'owner')).toContain('Stopped, as you asked.');
    expect(ended('stopped', 'refused-key')).toContain('BrickLink refused the keys');
    expect(ended('stopped', 'rate-limited')).toContain('asked to slow down');
    expect(ended('stopped', 'unreachable')).toContain('could not be reached');
    expect(ended('stopped', 'invoke-failed')).toContain('could not start');
    expect(ended('stopped', 'daily-limit')).toContain('again after midnight UTC: it carries on where it stopped');
    expect(ended('stopped', 'stalled')).toContain('the refresh stalled');
    for (const reason of STOP_REASONS) expect(outcomeText({ ...RUN, state: 'stopped', stopReason: reason })).not.toBe('');
  });
});

describe('the parts’ values', () => {
  const lot = (fields: Partial<PartsLotRow>): PartsLotRow => ({ id: randomUUID(), itemType: 'P', itemNo: '3001', colorId: 5, lotCondition: 'N', lotQuantity: 4, unitPrice: 0.125, value: null, ...fields });
  const page = (fields: Partial<PartsLotsPage> = {}): PartsLotsPage => ({
    page: 2,
    pages: 3,
    count: 250,
    fileCurrency: 'EUR',
    value: { amount: 1234.5, currency: 'EUR', fromBrickLink: 200, fromFile: 40, none: 10 },
    lots: [
      lot({ itemNo: '3001', value: { amount: 1.33, unitPrice: 0.333, source: 'bricklink', asOf: '2026-11-02T08:00:00.000Z' } }),
      lot({ itemNo: '3002', lotCondition: 'U', value: { amount: 0.5, unitPrice: 0.125, source: 'file', asOf: null } }),
      lot({ itemNo: '3003', unitPrice: null }),
    ],
    ...fields,
  });

  it('[VAL-11] shows the parts’ value by source and each lot with its unit price, value, source and date', () => {
    const html = renderToStaticMarkup(createElement(PartsValues, { values: page() }));
    for (const text of ['€1,234.50 in all', '200 lots from BrickLink', '40 lots from the file’s prices', '10 lots without a value', '€0.333', '€1.33', 'BrickLink, 2 Nov 2026', '>File<', '>None<', '>New<', '>Used<', 'Page 2 of 3']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('href="/admin/parts?page=1"');
    expect(html).toContain('href="/admin/parts?page=3"');
    expect(html.match(/<tr data-source=/g)).toHaveLength(3);
  });

  it('[VAL-11] shows a file price in another currency as the file’s, valuing nothing, and no page links for one page', () => {
    const html = renderToStaticMarkup(createElement(PartsValues, { values: page({ page: 1, pages: 1, fileCurrency: 'USD', value: { amount: null, currency: 'EUR', fromBrickLink: 0, fromFile: 0, none: 1 }, lots: [lot({ unitPrice: 2 })] }) }));
    expect(html).toContain('No lot has a value yet.');
    expect(html).toContain('$2.00 (file)');
    expect(html).not.toContain('?page=');
  });

  it('[VAL-11] reads the page from the query: a whole number from 1, anything else the first', () => {
    expect(parsePartsPage(undefined)).toBe(1);
    expect(parsePartsPage('3')).toBe(3);
    expect(parsePartsPage(['4', '5'])).toBe(4);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', ' 2', '9999999']) expect(parsePartsPage(bad), bad).toBe(1);
    expect(parsePartsPage('999999')).toBe(10_000);
  });
});

describe('the values in the list', () => {
  it('[VAL-7] shows each item’s value with its source and date, and no value as such', () => {
    const items: ListedItem[] = [
      { id: randomUUID(), kind: 'SET', setNum: '990001-1', refNo: null, name: 'Made-up ferry', condition: 'SEALED', quantity: 1, theme: 'Made-up Town', topTheme: null, year: 2020, complete: true, hasInstructions: true, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: null, version: 1, value: { amount: 1234.5, currency: 'EUR', source: 'bricklink', asOf: '2026-11-02T08:00:00.000Z' } },
      { id: randomUUID(), kind: 'BULK', setNum: null, refNo: null, name: 'Made-up tub', condition: 'USED_NO_BOX', quantity: 1, theme: null, topTheme: null, year: null, complete: null, hasInstructions: null, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: null, version: 1, value: { amount: 20, currency: 'EUR', source: 'override', asOf: null } },
      { id: randomUUID(), kind: 'OTHER', setNum: null, refNo: null, name: 'Made-up keychain', condition: 'USED_NO_BOX', quantity: 1, theme: null, topTheme: null, year: null, complete: null, hasInstructions: null, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: null, version: 1, value: null },
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
