// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemList } from '../../src/app/_admin/item-list';
import { QUEUE_STATE } from '../../src/app/_offline/client';
import { queueItem, type ListedItem } from '../../src/app/_offline/items';
import { openQueue } from '../../src/app/_offline/queue';
import { en } from '../../src/app/messages/en';

/**
 * `[ITEM-8]`: the item list on `/admin`, newest first as the server lists it, each item with its
 * cover through a presigned URL, its set number, name, condition and quantity; the items still in
 * the device's queue listed too, marked as not synced; and the filter by set number or name.
 * Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRESIGNED = 'https://photos.fake-s3.test/photos/made-up.webp?X-Amz-Expires=600&X-Amz-Signature=made-up';

const STOCK = 'https://cdn.rebrickable.com/media/sets/made-up-ferry.jpg';

const items: ListedItem[] = [
  { id: randomUUID(), kind: 'SET', setNum: '10294-1', refNo: null, name: 'Made-up Titanic', condition: 'SEALED', quantity: 1, theme: 'Made-up Town', topTheme: null, year: 2020, complete: true, hasInstructions: true, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: PRESIGNED, version: 1 },
  { id: randomUUID(), kind: 'SET', setNum: '75192-1', refNo: null, name: 'Made-up Falcon', condition: 'USED_WITH_BOX', quantity: 2, theme: 'Made-up Town', topTheme: null, year: 2020, complete: true, hasInstructions: true, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: null, version: 3 },
];

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

function rows(): string[] {
  return [...container.querySelectorAll('.item-row')].map((row) => row.textContent ?? '');
}

describe('the item list', () => {
  it('[ITEM-8] reloads to show what a sync just stored, and not after a sync that stored nothing', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as unknown as Location);
    await act(async () => root.render(createElement(ItemList, { items })));
    await settle();
    await act(async () => void window.dispatchEvent(new CustomEvent(QUEUE_STATE, { detail: { status: 'synced', entries: [], applied: 0 } })));
    expect(reload).not.toHaveBeenCalled();
    await act(async () => void window.dispatchEvent(new CustomEvent(QUEUE_STATE, { detail: { status: 'synced', entries: [], applied: 2 } })));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('[ITEM-8] shows the set’s stock image by default, the owner’s cover when there is none, and an empty tile with neither', () => {
    const thumbItems: ListedItem[] = [
      { id: randomUUID(), kind: 'SET', setNum: '99911-1', refNo: null, name: 'Made-up mill', condition: 'SEALED', quantity: 1, theme: 'Made-up Town', topTheme: null, year: 2020, complete: true, hasInstructions: true, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: PRESIGNED, version: 1 },
      { id: randomUUID(), kind: 'SET', setNum: '99912-1', refNo: null, name: 'Made-up ferry', condition: 'USED_WITH_BOX', quantity: 1, theme: 'Made-up Town', topTheme: null, year: 2020, complete: true, hasInstructions: true, hasMissingNotes: false, stockImageUrl: STOCK, coverThumbnailUrl: PRESIGNED, version: 1 },
      { id: randomUUID(), kind: 'SET', setNum: '99913-1', refNo: null, name: 'Made-up kiosk', condition: 'USED_NO_BOX', quantity: 1, theme: 'Made-up Town', topTheme: null, year: 2020, complete: true, hasInstructions: true, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: null, version: 1 },
    ];
    const html = renderToStaticMarkup(createElement(ItemList, { items: thumbItems }));
    const thumbs = [...html.matchAll(/<(img|span) class="item-row__thumb"[^>]*>/g)].map((match) => match[0]);
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]).toContain(`src="${PRESIGNED.replaceAll('&', '&amp;')}"`);
    expect(thumbs[1]).toContain(`src="${STOCK}"`);
    expect(thumbs[1]).toContain('alt="Catalogue image of 99912-1"');
    expect(thumbs[1]).toContain('referrerPolicy="no-referrer"');
    expect(thumbs[2]).toMatch(/^<span/);
  });

  it('[ITEM-8] shows each item in the order the server lists it, with its presigned cover, set number, name, condition and quantity, opening the entry form', () => {
    const html = renderToStaticMarkup(createElement(ItemList, { items }));
    expect(html.indexOf('10294-1 Made-up Titanic')).toBeLessThan(html.indexOf('75192-1 Made-up Falcon'));
    expect(html).toContain(`src="${PRESIGNED.replaceAll('&', '&amp;')}"`);
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('Sealed · ×1');
    expect(html).toContain('Used, box · ×2');
    expect(html).toContain(`href="/admin/items/${items[0]?.id}"`);
    expect(html).toContain('2 sets · 3 items');
  });

  it('[ITEM-8] lists the items still on the device first, marked as not synced, and marks a stored item with a queued change', async () => {
    const queue = await openQueue(indexedDB);
    const draft = { baseVersion: null, kind: 'SET' as const, name: '', refNo: '', approxParts: null, approxWeightG: null, condition: 'USED_NO_BOX' as const, complete: true, missingNotes: '', hasInstructions: true, description: '', quantity: 1, storageLocation: 'Made-up box', photos: [] };
    await queueItem(queue, { ...draft, id: randomUUID(), setNum: '21318-1' });
    await queueItem(queue, { ...draft, id: items[1]?.id ?? '', baseVersion: 3, setNum: '75192-1', condition: 'USED_WITH_BOX', quantity: 2 });
    queue.close();
    await act(async () => root.render(createElement(ItemList, { items })));
    await settle();
    expect(rows()).toEqual([`21318-1Used, no box · ×1${en.items.notSynced}`, '10294-1 Made-up TitanicSealed · ×1', `75192-1 Made-up FalconUsed, box · ×2${en.items.notSynced}`]);
  });

  it('[ITEM-8] filters by set number or name as the owner types', async () => {
    await act(async () => root.render(createElement(ItemList, { items })));
    await settle();
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (filter === null) throw new Error('no filter');
    const typeIn = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, value);
        filter.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await typeIn('falcon');
    expect(rows()).toEqual(['75192-1 Made-up FalconUsed, box · ×2']);
    await typeIn('10294');
    expect(rows()).toEqual(['10294-1 Made-up TitanicSealed · ×1']);
    await typeIn('nothing-like-it');
    expect(rows()).toEqual([]);
    expect(container.textContent).toContain(en.items.noMatch);
  });

  it('[ITEM-8] [ITEM-10] shows a non-set under its own name with a small kind label, never a stock image, and filters by its reference number', async () => {
    const mixed: ListedItem[] = [
      ...items,
      { id: randomUUID(), kind: 'MINIFIG', setNum: null, refNo: 'mu0001', name: 'Made-up pirate captain', condition: 'USED_NO_BOX', quantity: 1, theme: null, topTheme: null, year: null, complete: null, hasInstructions: null, hasMissingNotes: false, stockImageUrl: STOCK, coverThumbnailUrl: null, version: 1 },
      { id: randomUUID(), kind: 'BULK', setNum: null, refNo: null, name: 'Made-up mixed bricks', condition: 'USED_NO_BOX', quantity: 1, theme: null, topTheme: null, year: null, complete: null, hasInstructions: null, hasMissingNotes: false, stockImageUrl: null, coverThumbnailUrl: PRESIGNED, version: 1 },
    ];
    const html = renderToStaticMarkup(createElement(ItemList, { items: mixed }));
    // Even a stock image the row should never carry is not shown for a non-set.
    expect(html).not.toContain(STOCK);
    expect(html).toContain(`alt="Cover photo of Made-up mixed bricks"`);
    expect(html).toContain('2 sets · 2 other · 5 items');

    // The device's queue lists a non-set under its name too.
    const queue = await openQueue(indexedDB);
    const draft = { baseVersion: null, kind: 'OTHER' as const, setNum: '', name: 'Made-up keychain', refNo: '', approxParts: null, approxWeightG: null, condition: 'SEALED' as const, complete: null, missingNotes: '', hasInstructions: null, description: '', quantity: 1, storageLocation: '', photos: [] };
    await queueItem(queue, { ...draft, id: randomUUID() });
    queue.close();
    await act(async () => root.render(createElement(ItemList, { items: mixed })));
    await settle();
    expect(rows()).toEqual([
      `Made-up keychainSealed · ×1${en.items.kind.OTHER}${en.items.notSynced}`,
      '10294-1 Made-up TitanicSealed · ×1',
      '75192-1 Made-up FalconUsed, box · ×2',
      `Made-up pirate captainUsed, no box · ×1${en.items.kind.MINIFIG}`,
      `Made-up mixed bricksUsed, no box · ×1${en.items.kind.BULK}`,
    ]);
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (filter === null) throw new Error('no filter');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, 'MU0001');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows()).toEqual([`Made-up pirate captainUsed, no box · ×1${en.items.kind.MINIFIG}`]);
  });
});

describe('the item list’s filters and sort (#251)', () => {
  const set = (overrides: Partial<ListedItem>): ListedItem => ({
    id: randomUUID(),
    kind: 'SET',
    setNum: '990001-1',
    refNo: null,
    name: 'Made-up set',
    condition: 'USED_WITH_BOX',
    quantity: 1,
    theme: 'Made-up leaf',
    topTheme: 'Made-up Pirates',
    year: 2010,
    complete: true,
    hasInstructions: true,
    hasMissingNotes: false,
    stockImageUrl: null,
    coverThumbnailUrl: null,
    version: 1,
    value: null,
    ...overrides,
  });
  const ship = set({ setNum: '990001-1', name: 'Made-up ship', condition: 'SEALED', year: 2009, value: { amount: 300, currency: 'EUR', source: 'override', asOf: null } });
  const dojo = set({ setNum: '990002-1', name: 'Made-up dojo', topTheme: 'Made-up Ninjas', year: 2021, complete: false, value: { amount: 40, currency: 'EUR', source: 'override', asOf: null } });
  const hut = set({ setNum: '990003-1', name: 'Made-up hut', topTheme: null, year: 2015 });
  const diver = set({ kind: 'MINIFIG', setNum: null, name: 'Made-up diver', theme: null, topTheme: null, year: null, complete: null, hasInstructions: null });
  const listed = [ship, dojo, hut, diver];

  const names = () => [...container.querySelectorAll('.item-row__name')].map((name) => name.textContent?.replace(/^\d+-\d+ /, ''));
  const button = (text: string) => {
    const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith(text));
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  };
  const option = (legend: string, name: string) => {
    const group = [...container.querySelectorAll('fieldset')].find((one) => one.querySelector('legend')?.textContent === legend);
    const label = [...(group?.querySelectorAll('label') ?? [])].find((one) => one.querySelector('span')?.textContent === name);
    if (label === undefined) throw new Error(`no option ${name} under ${legend}`);
    return { input: label.querySelector('input') as HTMLInputElement, count: label.querySelector('.choice__count')?.textContent };
  };
  const tap = async (element: HTMLElement) => act(async () => void element.click());

  beforeEach(() => window.history.replaceState(null, '', '/admin'));

  it('[ITEM-14] [ITEM-17] opens behind one Filters button that says how many are on, and narrows the list as the owner taps, with no request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(createElement(ItemList, { items: listed })));
    await settle();
    expect(container.querySelector('.filters')).toBeNull();
    expect(button(en.items.filters.button(0)).getAttribute('aria-expanded')).toBe('false');
    await tap(button(en.items.filters.button(0)));
    expect(option('Theme', 'Made-up Ninjas').count).toBe('1');
    expect(option('Theme', 'Made-up Pirates').count).toBe('1');
    expect(option('Theme', en.items.filters.themeUnknown).count).toBe('1');
    expect(option('Kind', en.items.kind.OTHER).count).toBe('0');
    expect(option('Needs attention', en.items.filters.attention['no-value']).count).toBe('2');
    expect(option('Needs attention', en.items.filters.attention['incomplete-unnoted']).count).toBe('1');

    await tap(option('Kind', en.items.kind.SET).input);
    expect(names()).toEqual(['Made-up ship', 'Made-up dojo', 'Made-up hut']);
    expect(button(en.items.filters.button(1)).textContent).toBe('Filters · 1');
    // With Set chosen, the instructions' counts are of sets alone.
    expect(option('Instructions', en.items.filters.yesNo['not-recorded']).count).toBe('0');
    expect(option('Instructions', en.items.filters.yesNo.yes).count).toBe('3');
    await tap(option('Condition', en.condition.SEALED).input);
    expect(names()).toEqual(['Made-up ship']);
    expect(container.textContent).toContain(en.items.filters.shown(1, 4));
    // An option that would list none is still offered, with 0, and choosable.
    expect(option('Complete', en.items.filters.yesNo.no).count).toBe('0');
    await tap(option('Complete', en.items.filters.yesNo.no).input);
    expect(names()).toEqual([]);
    expect(container.textContent).toContain(en.items.noMatch);
    await tap(button(en.items.filters.clear));
    expect(names()).toEqual(['Made-up ship', 'Made-up dojo', 'Made-up hut', 'Made-up diver']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('[ITEM-16] sorts by value highest first or by year newest first, those without one last, the queued items staying above', async () => {
    const queue = await openQueue(indexedDB);
    const draft = { baseVersion: null, kind: 'SET' as const, name: '', refNo: '', approxParts: null, approxWeightG: null, condition: 'USED_NO_BOX' as const, complete: true, missingNotes: '', hasInstructions: true, description: '', quantity: 1, storageLocation: '', photos: [] };
    await queueItem(queue, { ...draft, id: randomUUID(), setNum: '990009-1' });
    queue.close();
    await act(async () => root.render(createElement(ItemList, { items: listed })));
    await settle();
    const select = container.querySelector('select');
    if (select === null) throw new Error('no sort');
    const choose = async (value: string) =>
      act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    expect(rows()[0]).toContain('990009-1');
    await choose('value');
    expect(rows()[0]).toContain('990009-1');
    expect(names().slice(1)).toEqual(['Made-up ship', 'Made-up dojo', 'Made-up hut', 'Made-up diver']);
    await choose('year');
    expect(names().slice(1)).toEqual(['Made-up dojo', 'Made-up hut', 'Made-up ship', 'Made-up diver']);
    expect(window.location.search).toBe('?sort=year');
    await choose('added');
    expect(window.location.search).toBe('');
  });

  it('[ITEM-18] opens with the query string’s list, ignoring what it doesn’t know, and writes each change back in place', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    await act(async () => root.render(createElement(ItemList, { items: listed, query: 'theme=Made-up+Ninjas&theme=Made-up+Space&condition=mint&sort=year' })));
    await settle();
    expect(names()).toEqual(['Made-up dojo']);
    expect(button(en.items.filters.button(1))).toBeDefined();
    // What it didn't know is dropped from the address.
    expect(window.location.search).toBe('?theme=Made-up+Ninjas&sort=year');
    await tap(button(en.items.filters.button(1)));
    await tap(option('Theme', 'Made-up Pirates').input);
    expect(names()).toEqual(['Made-up dojo', 'Made-up ship']);
    expect(window.location.pathname).toBe('/admin');
    expect(window.location.search).toBe('?theme=Made-up+Ninjas&theme=Made-up+Pirates&sort=year');
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (filter === null) throw new Error('no filter');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, 'ship');
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(window.location.search).toBe('?q=ship&theme=Made-up+Ninjas&theme=Made-up+Pirates&sort=year');
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('[ITEM-18] leaves the default list’s address with no query string', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    await act(async () => root.render(createElement(ItemList, { items: listed, query: '' })));
    await settle();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    vi.restoreAllMocks();
  });

  it('[ITEM-19] filters a queued new item on what the queue holds: every theme, its fields, and no value; a queued change as the stored item', async () => {
    const queue = await openQueue(indexedDB);
    const draft = { baseVersion: null, kind: 'SET' as const, name: '', refNo: '', approxParts: null, approxWeightG: null, condition: 'SEALED' as const, complete: false, missingNotes: '', hasInstructions: false, description: '', quantity: 1, storageLocation: '', photos: [] };
    await queueItem(queue, { ...draft, id: randomUUID(), setNum: '990009-1' });
    await queueItem(queue, { ...draft, id: randomUUID(), kind: 'MINIFIG', setNum: '', name: 'Made-up queued figure', refNo: 'mu0099', complete: null, hasInstructions: null });
    // A queued change to the dojo: it is filtered as the stored dojo.
    await queueItem(queue, { ...draft, id: dojo.id, baseVersion: 1, setNum: '990002-1', condition: 'SEALED' });
    queue.close();
    await act(async () => root.render(createElement(ItemList, { items: listed, query: 'theme=Made-up+Pirates' })));
    await settle();
    expect(names()).toEqual(['990009-1', 'Made-up ship']);
    await tap(button(en.items.filters.button(1)));
    expect(option('Theme', 'Made-up Ninjas').count).toBe('2');
    await tap(option('Theme', 'Made-up Pirates').input);
    await tap(option('Instructions', en.items.filters.yesNo['not-recorded']).input);
    expect(names()).toEqual(['Made-up queued figure', 'Made-up diver']);
    await tap(option('Instructions', en.items.filters.yesNo['not-recorded']).input);
    await tap(option('Needs attention', en.items.filters.attention['incomplete-unnoted']).input);
    // The queued set, incomplete with nothing noted; the dojo as stored, whatever its queued change says.
    expect(names()).toEqual(['990009-1', 'Made-up dojo']);
    await tap(option('Condition', en.condition.USED_WITH_BOX).input);
    expect(names()).toEqual(['Made-up dojo']);
    await tap(option('Condition', en.condition.USED_WITH_BOX).input);
    await tap(option('Needs attention', en.items.filters.attention['incomplete-unnoted']).input);
    await tap(option('Needs attention', en.items.filters.attention['no-value']).input);
    // The queue's newest first.
    expect(names()).toEqual(['Made-up queued figure', '990009-1', 'Made-up hut', 'Made-up diver']);
  });
});
