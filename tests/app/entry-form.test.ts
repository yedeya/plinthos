// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ITEM_MUTATION, SET_SEARCH_ENDPOINT, type EditableItem } from '../../src/app/_offline/items';
import { openQueue, type QueuedEntry } from '../../src/app/_offline/queue';
import { en } from '../../src/app/messages/en';

/**
 * `[ITEM-9]`: the one-screen entry form, rendered in a DOM with an IndexedDB stand-in and a
 * stand-in for the admin's set search route. Saving queues the item's mutations on the device in
 * `[ITEM-7]`'s order and never calls the server itself; the offline shell's form takes a typed set
 * number and makes no request at all ([SYNC-6]); a search that is unavailable falls back to a
 * typed set number ([CAT-5]). Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The phone's resize needs a canvas the DOM stand-in lacks: each photo becomes a few made-up bytes.
// A test that needs a slow resize, as on a phone, holds it back until it opens `resizeGate`.
let resizeGate: Promise<void> | undefined;
vi.mock('../../src/app/_offline/photos', async (original) => ({
  ...(await original<typeof import('../../src/app/_offline/photos')>()),
  preparePhoto: async (file: Blob) => {
    await resizeGate;
    return new Uint8Array([0xff, 0xd8, ...new Uint8Array(await file.arrayBuffer()), 0xff, 0xd9]).buffer;
  },
}));

const { EntryForm } = await import('../../src/app/_admin/entry-form');
const offlinePage = await import('../../src/app/offline/page');

const SET = { setNum: '10294-1', name: 'Made-up Titanic', theme: 'Made-up Icons', year: 2021, numParts: 9090, imageUrl: 'https://cdn.rebrickable.com/media/sets/made-up.jpg' };

let root: Root;
let container: HTMLElement;
let requests: string[];
let answer: () => Response;
const assign = vi.fn();

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  requests = [];
  answer = () => Response.json({ status: 'ok', sets: [SET] });
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(String(url));
    return answer();
  });
  let objectUrls = 0;
  URL.createObjectURL = () => `blob:made-up-${++objectUrls}`;
  URL.revokeObjectURL = () => undefined;
  setOnline(true);
  assign.mockClear();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
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

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root.render(element));
  await settle();
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

async function wait(ms: number): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  await settle();
}

function field(name: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (found === null) throw new Error(`no ${name} field`);
  return found;
}

/** Types into a field as React sees it: the native value setter, then an input event. */
async function type(name: string, value: string): Promise<void> {
  const input = field(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label);
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle();
}

async function chooseCondition(label: string): Promise<void> {
  const choice = [...container.querySelectorAll<HTMLLabelElement>('label.choice')].find((candidate) => candidate.textContent === label);
  const input = choice?.querySelector('input');
  if (input == null) throw new Error(`no ${label} choice`);
  await click(input);
}

async function addPhotos(...contents: string[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no photo input');
  const files = contents.map((content, index) => new File([content], `made-up-${index}.jpg`, { type: 'image/jpeg' }));
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
}

async function queued(): Promise<QueuedEntry[]> {
  const queue = await openQueue(indexedDB);
  try {
    return await queue.entries();
  } finally {
    queue.close();
  }
}

describe('the entry form', () => {
  it('[ITEM-9] searches from two characters, 300 ms after the last keystroke, and shows the set with its stock image', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('setSearch', '1');
    await wait(400);
    expect(requests).toEqual([]);
    for (const query of ['10', '102', '1029']) await type('setSearch', query);
    await wait(100);
    expect(requests).toEqual([]);
    await wait(300);
    expect(requests).toEqual([`${SET_SEARCH_ENDPOINT}?q=1029`]);
    expect(container.textContent).toContain('10294-1 Made-up Titanic');
    expect(container.textContent).toContain('Made-up Icons · 2021 · 9,090 pcs');
    const image = container.querySelector('img.set-result__image');
    expect(image?.getAttribute('src')).toBe(SET.imageUrl);
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('[ITEM-9] Save & add next queues the item, shows the toast, and keeps the condition and the storage location for the next set', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('setSearch', '10294');
    await wait(350);
    await click(button(`${SET.setNum} ${SET.name}${SET.theme} · 2021 · 9,090 pcs`));
    await chooseCondition('Used, box');
    await type('storageLocation', 'Made-up attic box 3');
    await type('description', 'Made-up note');
    await click(button(en.form.increase));
    await click(button(en.form.saveAndNext));

    const entries = await queued();
    expect(entries.map((entry) => entry.name)).toEqual([ITEM_MUTATION.save]);
    expect(entries[0]?.input).toMatchObject({ setNum: '10294-1', condition: 'USED_WITH_BOX', quantity: 2, description: 'Made-up note', storageLocation: 'Made-up attic box 3', baseVersion: null });
    expect(container.querySelector('.toast')?.textContent).toBe('Saved 10294-1 · 0 photos');

    // The next set starts from the same condition and storage location, and nothing else.
    expect(field('storageLocation').value).toBe('Made-up attic box 3');
    expect(container.querySelector<HTMLInputElement>('input[name="condition"][value="USED_WITH_BOX"]')?.checked).toBe(true);
    expect(field('description').value).toBe('');
    expect(field('quantity').value).toBe('1');
    expect(field('setSearch').value).toBe('');
    expect(document.activeElement).toBe(field('setSearch'));
    expect(assign).not.toHaveBeenCalled();

    await wait(3100);
    expect(container.querySelector('.toast')).toBeNull();
  });

  it('[ITEM-9] shows what is wrong under each field, queues nothing and keeps what was entered', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('storageLocation', 'Made-up shelf');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toEqual([]);
    expect(container.querySelectorAll('.field__error').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain(en.form.problems.required);
    expect(field('storageLocation').value).toBe('Made-up shelf');
  });

  it('[CAT-5] [ITEM-9] says search is unavailable and takes the typed set number instead', async () => {
    answer = () => Response.json({ status: 'unavailable' });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('setSearch', '75192');
    await wait(350);
    expect(container.textContent).toContain(en.form.search.unavailable);
    expect(container.textContent).toContain(en.form.search.typedHint);
    expect(field('setNum').value).toBe('75192');
    await chooseCondition('Sealed');
    await click(button(en.form.save));
    expect((await queued())[0]?.input).toMatchObject({ setNum: '75192-1', condition: 'SEALED' });
    expect(assign).toHaveBeenCalledWith('/admin');
  });

  it('[ITEM-7] [ITEM-9] the photo strip adds photos, makes one the cover by moving it first, moves and removes them, and the save queues them in that order', async () => {
    answer = () => Response.json({ status: 'unavailable' });
    await render(createElement(EntryForm, { mode: 'new' }));
    await click(button(en.form.search.useTyped));
    await type('setNum', '21318-1');
    await chooseCondition('Used, no box');
    await addPhotos('a', 'b', 'c');
    expect(container.querySelectorAll('.photo-strip img')).toHaveLength(3);
    expect(button(en.form.photos.photoLabel(1, true))).toBeDefined();

    await click(button(en.form.photos.photoLabel(3, false)));
    await click(button(en.form.photos.makeCover));
    // c, a, b
    await click(button(en.form.photos.photoLabel(2, false)));
    await click(button(en.form.photos.moveRight));
    // c, b, a
    await click(button(en.form.photos.photoLabel(2, false)));
    await click(button(en.form.photos.remove));
    // c, a
    expect(container.querySelectorAll('.photo-strip img')).toHaveLength(2);

    await click(button(en.form.saveAndNext));
    const entries = await queued();
    expect(entries.map((entry) => entry.name)).toEqual([ITEM_MUTATION.save, 'registerPhoto', 'registerPhoto']);
    const itemId = (entries[0]?.input as { id: string }).id;
    expect(entries.slice(1).map((entry) => entry.input as { itemId: string; position: number })).toEqual([
      expect.objectContaining({ itemId, position: 0 }),
      expect.objectContaining({ itemId, position: 1 }),
    ]);
    // The cover is the first photo queued, which the server makes the cover ([ITEM-6]).
    expect(entries.slice(1).map((entry) => String.fromCharCode(new Uint8Array(entry.upload?.bytes ?? new ArrayBuffer(3))[2] ?? 0))).toEqual(['c', 'a']);
    expect(container.querySelector('.toast')?.textContent).toBe('Saved 21318-1 · 2 photos');
    expect(container.querySelectorAll('.photo-strip img')).toHaveLength(0);
  });

  it('[ITEM-9] a second submit straight after Save & add next does nothing, and flags no field on the emptied form', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('setSearch', '10294');
    await wait(350);
    await click(button(`${SET.setNum} ${SET.name}${SET.theme} · 2021 · 9,090 pcs`));
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toHaveLength(1);

    // A double tap or the keyboard's Go submits the emptied form again.
    await act(async () => container.querySelector('form')?.requestSubmit());
    await settle();
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('.field__error')).toHaveLength(0);
    expect(await queued()).toHaveLength(1);

    // Save, tapped on the emptied form, has nothing to save and goes back to the items (#147).
    await click(button(en.form.save));
    expect(assign).toHaveBeenCalledWith('/admin');
    expect(await queued()).toHaveLength(1);

    // Enter in the set search never submits the set.
    const search = field('setSearch');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => search.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
  });

  it('[ITEM-7] [ITEM-9] waits for a photo still being prepared, so a save never leaves it behind', async () => {
    let open: () => void = () => undefined;
    resizeGate = new Promise((resolve) => (open = resolve));
    try {
      answer = () => Response.json({ status: 'unavailable' });
      await render(createElement(EntryForm, { mode: 'new' }));
      await click(button(en.form.search.useTyped));
      await type('setNum', '99902-1');
      await chooseCondition('Sealed');
      await addPhotos('a');

      // The photo is being resized: a placeholder shows at once, and neither save can run.
      expect(container.querySelectorAll('.photo-tile--preparing')).toHaveLength(1);
      const next = button(en.form.preparingPhotos);
      expect(next.disabled).toBe(true);
      await act(async () => container.querySelector('form')?.requestSubmit());
      await settle();
      expect(await queued()).toEqual([]);

      await act(async () => open());
      await settle();
      expect(container.querySelectorAll('.photo-tile--preparing')).toHaveLength(0);
      expect(container.querySelectorAll('.photo-strip img')).toHaveLength(1);
      await click(button(en.form.saveAndNext));
      expect((await queued()).map((entry) => entry.name)).toEqual([ITEM_MUTATION.save, 'registerPhoto']);
    } finally {
      resizeGate = undefined;
    }
  });
});

describe('the offline shell’s form', () => {
  it('[ITEM-9] [SYNC-6] a second submit straight after Save & add next flags no field on the emptied offline form', async () => {
    await render(createElement(EntryForm, { mode: 'offline' }));
    await type('setNum', '99901');
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toHaveLength(1);
    expect(document.activeElement).toBe(field('setNum'));

    // A double tap, or the keyboard's Go in the focused set number, submits the emptied form again.
    await act(async () => container.querySelector('form')?.requestSubmit());
    await settle();
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('.field__error')).toHaveLength(0);
    expect(await queued()).toHaveLength(1);
  });

  it('[ITEM-9] [SYNC-6] takes a typed set number only and makes no request, before or after it saves', async () => {
    await render(createElement(EntryForm, { mode: 'offline' }));
    expect(container.querySelector('[name="setSearch"]')).toBeNull();
    await type('setNum', '10294');
    await chooseCondition('Sealed');
    await wait(400);
    await click(button(en.form.saveAndNext));
    expect((await queued())[0]?.input).toMatchObject({ setNum: '10294-1', condition: 'SEALED' });
    expect(requests).toEqual([]);
  });

  it('[ITEM-9] [SYNC-6] prerenders /offline with the typed set number and no search, from no server data', () => {
    const html = renderToStaticMarkup(createElement(offlinePage.default));
    expect(html).toContain('name="setNum"');
    expect(html).not.toContain('name="setSearch"');
    expect(html).not.toContain(en.form.delete);
    expect(html).toContain('Save &amp; add next');
  });
});

describe('the edit form', () => {
  const photoId = randomUUID();
  const item: EditableItem = {
    id: randomUUID(),
    version: 5,
    set: SET,
    condition: 'USED_WITH_BOX',
    complete: false,
    missingNotes: 'Made-up missing minifigure',
    hasInstructions: false,
    description: 'Made-up description',
    quantity: 2,
    storageLocation: 'Made-up attic',
    photos: [{ id: photoId, thumbnailUrl: 'https://photos.fake-s3.test/made-up-thumb?X-Amz-Signature=made-up', cover: true }],
  };

  it('[ITEM-9] [ITEM-3] opens with the item, offers Save alone, and saves with the version it was opened at', async () => {
    await render(createElement(EntryForm, { mode: 'edit', item }));
    expect(container.textContent).not.toContain(en.form.saveAndNext);
    expect(field('missingNotes').value).toBe('Made-up missing minifigure');
    expect(field('storageLocation').value).toBe('Made-up attic');
    expect(container.querySelector('.photo-strip img')?.getAttribute('src')).toBe(item.photos[0]?.thumbnailUrl);
    await type('quantity', '3');
    await click(button(en.form.save));
    const entries = await queued();
    expect(entries.map((entry) => entry.name)).toEqual([ITEM_MUTATION.save]);
    expect(entries[0]).toMatchObject({ input: { id: item.id, baseVersion: 5, quantity: 3, complete: false, missingNotes: 'Made-up missing minifigure' } });
    expect(assign).toHaveBeenCalledWith('/admin');
    expect(requests).toEqual([]);
  });

  it('[ITEM-9] [ITEM-5] deletes the set only once the owner confirms', async () => {
    await render(createElement(EntryForm, { mode: 'edit', item }));
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
    await click(button(en.form.delete));
    expect(confirm).toHaveBeenCalledWith(en.form.confirmDelete);
    expect(await queued()).toEqual([]);
    confirm.mockReturnValue(true);
    await click(button(en.form.delete));
    expect((await queued()).map((entry) => [entry.name, entry.input])).toEqual([[ITEM_MUTATION.delete, { id: item.id }]]);
    expect(assign).toHaveBeenCalledWith('/admin');
  });
});
