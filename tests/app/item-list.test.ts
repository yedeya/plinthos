// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemList } from '../../src/app/_admin/item-list';
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

const items: ListedItem[] = [
  { id: randomUUID(), setNum: '10294-1', name: 'Made-up Titanic', condition: 'SEALED', quantity: 1, coverThumbnailUrl: PRESIGNED, version: 1 },
  { id: randomUUID(), setNum: '75192-1', name: 'Made-up Falcon', condition: 'USED_WITH_BOX', quantity: 2, coverThumbnailUrl: null, version: 3 },
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
    const draft = { baseVersion: null, condition: 'USED_NO_BOX' as const, complete: true, missingNotes: '', hasInstructions: true, description: '', quantity: 1, storageLocation: 'Made-up box', photos: [] };
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
});
