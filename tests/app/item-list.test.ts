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

/** What the filters and the sort read of a stored item ([ITEM-20]), as the server lists a set with no theme known yet. */
const FILTERED = { theme: null, topTheme: null, year: null, complete: true, hasInstructions: true, hasMissingNotes: false } as const;

const items: ListedItem[] = [
  { id: randomUUID(), kind: 'SET', setNum: '10294-1', refNo: null, name: 'Made-up Titanic', condition: 'SEALED', quantity: 1, stockImageUrl: null, coverThumbnailUrl: PRESIGNED, version: 1, ...FILTERED },
  { id: randomUUID(), kind: 'SET', setNum: '75192-1', refNo: null, name: 'Made-up Falcon', condition: 'USED_WITH_BOX', quantity: 2, stockImageUrl: null, coverThumbnailUrl: null, version: 3, ...FILTERED },
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
      { id: randomUUID(), kind: 'SET', setNum: '99911-1', refNo: null, name: 'Made-up mill', condition: 'SEALED', quantity: 1, stockImageUrl: null, coverThumbnailUrl: PRESIGNED, version: 1, ...FILTERED },
      { id: randomUUID(), kind: 'SET', setNum: '99912-1', refNo: null, name: 'Made-up ferry', condition: 'USED_WITH_BOX', quantity: 1, stockImageUrl: STOCK, coverThumbnailUrl: PRESIGNED, version: 1, ...FILTERED },
      { id: randomUUID(), kind: 'SET', setNum: '99913-1', refNo: null, name: 'Made-up kiosk', condition: 'USED_NO_BOX', quantity: 1, stockImageUrl: null, coverThumbnailUrl: null, version: 1, ...FILTERED },
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
      { id: randomUUID(), kind: 'MINIFIG', setNum: null, refNo: 'mu0001', name: 'Made-up pirate captain', condition: 'USED_NO_BOX', quantity: 1, stockImageUrl: STOCK, coverThumbnailUrl: null, version: 1, ...FILTERED },
      { id: randomUUID(), kind: 'BULK', setNum: null, refNo: null, name: 'Made-up mixed bricks', condition: 'USED_NO_BOX', quantity: 1, stockImageUrl: null, coverThumbnailUrl: PRESIGNED, version: 1, ...FILTERED },
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

describe('the filters, counts and sort on the list', () => {
  const value = (amount: number) => ({ amount, currency: 'EUR', source: 'override' as const, asOf: null });
  const set = (setNum: string, name: string, fields: Partial<ListedItem>): ListedItem => ({
    id: randomUUID(),
    kind: 'SET',
    setNum,
    refNo: null,
    name,
    condition: 'SEALED',
    quantity: 1,
    stockImageUrl: null,
    coverThumbnailUrl: null,
    version: 1,
    ...FILTERED,
    value: null,
    ...fields,
  });
  const themed: ListedItem[] = [
    set('99021-1', 'Made-up galleon', { theme: 'Made-up Pirates II', topTheme: 'Made-up Pirates', year: 2015, value: value(90) }),
    set('99022-1', 'Made-up dojo', { theme: 'Made-up Spinners', topTheme: 'Made-up Ninjas', year: 2021, condition: 'USED_WITH_BOX', complete: false, value: value(30) }),
    set('99023-1', 'Made-up temple', { theme: 'Made-up Ninjas', topTheme: 'Made-up Ninjas', year: 2012, condition: 'USED_NO_BOX' }),
    { ...set('', 'Made-up captain', { condition: 'USED_NO_BOX', complete: null, hasInstructions: null, value: value(200) }), kind: 'MINIFIG', setNum: null },
  ];

  const names = () => [...container.querySelectorAll('.item-row__name')].map((name) => name.textContent);
  const filtersButton = () => {
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.startsWith(en.items.filters.button(0)) === true);
    if (button === undefined) throw new Error('no Filters button');
    return button;
  };
  const group = (legend: string) => {
    const fieldset = [...container.querySelectorAll('fieldset')].find((candidate) => candidate.querySelector('legend')?.textContent === legend);
    if (fieldset === undefined) throw new Error(`no ${legend} group`);
    return fieldset;
  };
  const optionTexts = (legend: string) => [...group(legend).querySelectorAll('label')].map((label) => label.textContent);
  const option = (legend: string, label: string) => {
    const found = [...group(legend).querySelectorAll('label')].find((candidate) => candidate.querySelector('.choice__label')?.textContent === label)?.querySelector('input');
    if (found === null || found === undefined) throw new Error(`no ${label} in ${legend}`);
    return found;
  };
  const click = async (element: HTMLElement) => act(async () => element.click());
  const typeIn = async (value: string) => {
    const filter = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (filter === null) throw new Error('no filter');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, value);
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const at = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);
  const t = en.items.filters;

  it('[ITEM-14] [ITEM-17] filters the list in the browser behind one Filters button, which counts the filters that are on, with a count on every option', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    await act(async () => root.render(createElement(ItemList, { items: themed })));
    await settle();
    // Closed, the list starts right under the search box and the button.
    expect(container.querySelector('fieldset')).toBeNull();
    expect(filtersButton().textContent).toBe(t.button(0));
    expect(filtersButton().getAttribute('aria-expanded')).toBe('false');
    await click(filtersButton());
    expect(filtersButton().getAttribute('aria-expanded')).toBe('true');

    expect(optionTexts(t.theme)).toEqual(['Made-up Ninjas 2', 'Made-up Pirates 1']);
    expect(optionTexts(t.condition)).toEqual(['Sealed 1', 'Used, box 1', 'Used, no box 2']);
    expect(optionTexts(t.complete)).toEqual([`${t.yesNo.yes} 2`, `${t.yesNo.no} 1`, `${t.yesNo.unknown} 1`]);
    expect(optionTexts(t.kind)).toEqual(['Set 3', 'Minifigure 1', 'Bulk lot 0', 'Other 0']);
    expect(optionTexts(t.attention)).toEqual([`${t.attentionOptions['no-value']} 1`, `${t.attentionOptions['incomplete-unnoted']} 1`]);

    await click(option(t.theme, 'Made-up Ninjas'));
    expect(names()).toEqual(['99022-1 Made-up dojo', '99023-1 Made-up temple']);
    expect(filtersButton().textContent).toBe(t.button(1));
    // Every other filter counts under the theme; the theme's own options don't.
    expect(optionTexts(t.condition)).toEqual(['Sealed 0', 'Used, box 1', 'Used, no box 1']);
    expect(optionTexts(t.theme)).toEqual(['Made-up Ninjas 2', 'Made-up Pirates 1']);
    // An option that would show none is still offered, and choosable.
    expect(option(t.condition, 'Sealed').disabled).toBe(false);

    await click(option(t.attention, t.attentionOptions['no-value']));
    expect(names()).toEqual(['99023-1 Made-up temple']);
    expect(filtersButton().textContent).toBe(t.button(2));
    await typeIn('dojo');
    expect(names()).toEqual([]);
    expect(container.textContent).toContain(en.items.noMatch);

    // Clear takes the filters off, and leaves the text filter as typed.
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === t.clear) as HTMLElement);
    expect(names()).toEqual(['99022-1 Made-up dojo']);
    expect(filtersButton().textContent).toBe(t.button(0));
    expect(send).not.toHaveBeenCalled();
  });

  it('[ITEM-14] offers Theme not known for a set whose top-level theme isn’t known yet', async () => {
    await act(async () => root.render(createElement(ItemList, { items: [...themed, set('99024-1', 'Made-up fort', { year: 2019 })] })));
    await settle();
    await click(filtersButton());
    expect(optionTexts(t.theme)).toEqual(['Made-up Ninjas 2', 'Made-up Pirates 1', `${t.themeUnknown} 1`]);
    await click(option(t.theme, t.themeUnknown));
    expect(names()).toEqual(['99024-1 Made-up fort']);
  });

  it('[ITEM-16] sorts the stored items by value or by year, the queued ones staying above in the queue’s order', async () => {
    const queue = await openQueue(indexedDB);
    const draft = { baseVersion: null, kind: 'SET' as const, name: '', refNo: '', approxParts: null, approxWeightG: null, condition: 'SEALED' as const, complete: true, missingNotes: '', hasInstructions: true, description: '', quantity: 1, storageLocation: '', photos: [] };
    await queueItem(queue, { ...draft, id: randomUUID(), setNum: '99028-1' });
    await queueItem(queue, { ...draft, id: randomUUID(), setNum: '99029-1' });
    queue.close();
    await act(async () => root.render(createElement(ItemList, { items: themed })));
    await settle();
    expect(names()).toEqual(['99029-1', '99028-1', '99021-1 Made-up galleon', '99022-1 Made-up dojo', '99023-1 Made-up temple', 'Made-up captain']);
    await click(filtersButton());
    await click(option(t.sort, t.sortOptions.value));
    expect(names()).toEqual(['99029-1', '99028-1', 'Made-up captain', '99021-1 Made-up galleon', '99022-1 Made-up dojo', '99023-1 Made-up temple']);
    await click(option(t.sort, t.sortOptions.year));
    expect(names()).toEqual(['99029-1', '99028-1', '99022-1 Made-up dojo', '99021-1 Made-up galleon', '99023-1 Made-up temple', 'Made-up captain']);
    // The sort is not a filter the button counts.
    expect(filtersButton().textContent).toBe(t.button(0));
  });

  it('[ITEM-19] lists a queued set under every theme and a queued non-set under none, and counts them so', async () => {
    const queue = await openQueue(indexedDB);
    const draft = { baseVersion: null, name: '', refNo: '', approxParts: null, approxWeightG: null, condition: 'SEALED' as const, missingNotes: '', description: '', quantity: 1, storageLocation: '', photos: [] };
    await queueItem(queue, { ...draft, id: randomUUID(), kind: 'SET', setNum: '99029-1', complete: true, hasInstructions: false });
    await queueItem(queue, { ...draft, id: randomUUID(), kind: 'OTHER', setNum: '', name: 'Made-up keychain', complete: null, hasInstructions: null });
    queue.close();
    await act(async () => root.render(createElement(ItemList, { items: themed })));
    await settle();
    await click(filtersButton());
    expect(optionTexts(t.theme)).toEqual(['Made-up Ninjas 3', 'Made-up Pirates 2']);
    await click(option(t.theme, 'Made-up Pirates'));
    expect(names()).toEqual(['99029-1', '99021-1 Made-up galleon']);
    await click(option(t.theme, 'Made-up Pirates'));
    await click(option(t.instructions, t.yesNo.no));
    expect(names()).toEqual(['99029-1']);
    await click(option(t.instructions, t.yesNo.no));
    await click(option(t.complete, t.yesNo.unknown));
    expect(names()).toEqual(['Made-up keychain', 'Made-up captain']);
  });

  it('[ITEM-18] opens with the filters, the text and the sort the query string holds, and writes each change in place, the default list with none', async () => {
    at('https://admin.plinthos.test/admin?theme=Made-up+Ninjas&sort=year&q=made-up&kind=nonsense');
    const query = { theme: 'Made-up Ninjas', sort: 'year', q: 'made-up', kind: 'nonsense' };
    // As the server renders it, before any script runs.
    const html = renderToStaticMarkup(createElement(ItemList, { items: themed, query }));
    expect([...html.matchAll(/class="item-row__name">([^<]*)</g)].map((match) => match[1])).toEqual(['99022-1 Made-up dojo', '99023-1 Made-up temple']);

    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const push = vi.spyOn(window.history, 'pushState');
    await act(async () => root.render(createElement(ItemList, { items: themed, query })));
    await settle();
    expect(names()).toEqual(['99022-1 Made-up dojo', '99023-1 Made-up temple']);
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('made-up');
    expect(filtersButton().textContent).toBe(t.button(1));

    await click(filtersButton());
    await click(option(t.condition, 'Used, no box'));
    expect(names()).toEqual(['99023-1 Made-up temple']);
    expect(window.location.pathname).toBe('/admin');
    expect(new URLSearchParams(window.location.search).getAll('condition')).toEqual(['used-no-box']);
    expect(new URLSearchParams(window.location.search).get('sort')).toBe('year');

    // A reload, a bookmark or going back reads the same query string, and shows the same list.
    const reopened = Object.fromEntries(new URLSearchParams(window.location.search));
    expect(renderToStaticMarkup(createElement(ItemList, { items: themed, query: reopened }))).toContain('99023-1 Made-up temple');
    expect(renderToStaticMarkup(createElement(ItemList, { items: themed, query: reopened }))).not.toContain('99022-1 Made-up dojo');

    await click([...container.querySelectorAll('button')].find((button) => button.textContent === t.clear) as HTMLElement);
    await typeIn('');
    await click(option(t.sort, t.sortOptions.added));
    expect(window.location.href).toBe('https://admin.plinthos.test/admin');
    expect(push).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
