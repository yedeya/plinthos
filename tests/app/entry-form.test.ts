// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ITEM_MUTATION, SET_SEARCH_ENDPOINT, type EditableItem } from '../../src/app/_offline/items';
import { QUEUE_CHANGED, QUEUE_PROGRESS, QUEUE_STATE } from '../../src/app/_offline/client';
import { openQueue, type QueuedEntry } from '../../src/app/_offline/queue';
import { en } from '../../src/app/messages/en';

/**
 * `[ITEM-9]`: the one-screen entry form, rendered in a DOM with an IndexedDB stand-in and a
 * stand-in for the admin's set search route. Saving queues the item's mutations on the device in
 * `[ITEM-7]`'s order and never calls the server itself. One field takes a set number or a name:
 * it searches after a pause that depends on what was typed, aborting older searches, and a typed
 * set number saves without a pick. The offline shell's form makes no request at all ([SYNC-6]),
 * and a search that isn't answering says so quietly ([CAT-5]). Every value is made up.
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
  // Stands in for the page's queue sync: each change queued is answered as synced at once. A test
  // that needs the sync to lag sets `holdSync`.
  holdSync = false;
  window.addEventListener(QUEUE_CHANGED, answerSync);
});

let holdSync = false;
function announceSynced(): void {
  window.dispatchEvent(new CustomEvent(QUEUE_STATE, { detail: { status: 'synced', entries: [], applied: 1 } }));
}
function answerSync(): void {
  if (!holdSync) setTimeout(announceSynced, 0);
}

afterEach(async () => {
  window.removeEventListener(QUEUE_CHANGED, answerSync);
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
  it('[ITEM-9] waits about a second after the last digit of a set number and half a second after a name, from two characters, and shows the set with its stock image', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => root.render(createElement(EntryForm, { mode: 'new' })));
      const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
      await type('set', '1');
      await advance(2000);
      expect(requests).toEqual([]);
      for (const text of ['10', '102', '1029']) {
        await type('set', text);
        await advance(900);
      }
      expect(requests).toEqual([]);
      await advance(100);
      expect(requests).toEqual([`${SET_SEARCH_ENDPOINT}?q=1029`]);

      await type('set', 'Ti');
      await type('set', 'Tit');
      await advance(400);
      expect(requests).toHaveLength(1);
      await advance(100);
      expect(requests.at(-1)).toBe(`${SET_SEARCH_ENDPOINT}?q=Tit`);
      expect(container.textContent).toContain('10294-1 Made-up Titanic');
      expect(container.textContent).toContain('Made-up Icons · 2021 · 9,090 pcs');
      const image = container.querySelector('img.set-result__image');
      expect(image?.getAttribute('src')).toBe(SET.imageUrl);
      expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('[ITEM-9] aborts the search for older text when the owner types on, and never shows its late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signals: AbortSignal[] = [];
    const late: ((response: Response) => void)[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      requests.push(String(url));
      if (init.signal) signals.push(init.signal);
      return new Promise<Response>((resolve) => late.push(resolve));
    });
    try {
      await act(async () => root.render(createElement(EntryForm, { mode: 'new' })));
      const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
      await type('set', 'Titan');
      await advance(500);
      expect(requests).toEqual([`${SET_SEARCH_ENDPOINT}?q=Titan`]);
      await type('set', 'Titanic');
      expect(signals[0]?.aborted).toBe(true);
      // The older search answers anyway, late: its set is never shown.
      await act(async () => late[0]?.(Response.json({ status: 'ok', sets: [{ ...SET, setNum: '99940-1', name: 'Made-up stale answer' }] })));
      expect(container.textContent).not.toContain('Made-up stale answer');
      await advance(500);
      expect(requests.at(-1)).toBe(`${SET_SEARCH_ENDPOINT}?q=Titanic`);
      await act(async () => late[1]?.(Response.json({ status: 'ok', sets: [SET] })));
      await advance(10);
      expect(container.textContent).toContain('10294-1 Made-up Titanic');
      expect(container.textContent).not.toContain('Made-up stale answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('[ITEM-9] [ITEM-4] saves a typed set number without a pick, resolved when it syncs', async () => {
    answer = () => Response.json({ status: 'ok', sets: [] });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '99931');
    expect(container.textContent).toContain(en.form.search.willResolve('99931-1'));
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect((await queued())[0]?.input).toMatchObject({ setNum: '99931-1', condition: 'SEALED' });
    expect(container.querySelector('.toast')?.textContent).toBe('Saved 99931-1 · 0 photos');
  });

  it('[ITEM-9] uses the result that is exactly the typed set number as the chosen set', async () => {
    answer = () => Response.json({ status: 'ok', sets: [{ ...SET, setNum: '10294-2' }, SET] });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '10294');
    expect(container.textContent).toContain(en.form.search.willResolve('10294-1'));
    await wait(1100);
    expect(container.textContent).toContain(en.form.search.willSave('10294-1'));
    expect(container.textContent).not.toContain(en.form.search.willResolve('10294-1'));
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect((await queued())[0]?.input).toMatchObject({ setNum: '10294-1' });
  });

  it('[ITEM-9] asks the owner to pick a set when a name was typed and nothing picked, and queues nothing', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', 'Titanic');
    await wait(600);
    expect(container.querySelector('.field__hint')?.textContent ?? '').toBe('');
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toEqual([]);
    expect(container.textContent).toContain(en.form.problems.pickSet);
    expect(field('set').value).toBe('Titanic');
  });

  it('[CAT-5] [ITEM-9] says quietly when search is unavailable, or answers only sets already saved, and still saves by set number in the same field', async () => {
    answer = () => Response.json({ status: 'ok', sets: [SET], partial: true });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', 'Titanic');
    await wait(600);
    expect(container.textContent).toContain(en.form.search.partial);
    expect(container.textContent).toContain('10294-1 Made-up Titanic');

    answer = () => Response.json({ status: 'unavailable' });
    await type('set', '75192');
    await wait(1100);
    expect(container.textContent).toContain(en.form.search.unavailable);
    expect(field('set').value).toBe('75192');
    await chooseCondition('Sealed');
    await click(button(en.form.save));
    expect((await queued())[0]?.input).toMatchObject({ setNum: '75192-1', condition: 'SEALED' });
    expect(assign).toHaveBeenCalledWith('/admin');
  });

  it('[ITEM-9] [SYNC-6] sends no search from a device without a network, and still saves the typed set number', async () => {
    setOnline(false);
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '10294');
    await wait(1100);
    expect(requests).toEqual([]);
    expect(container.textContent).toContain(en.form.search.willResolve('10294-1'));
  });

  it('[ITEM-9] Save & add next queues the item, shows the toast, and keeps the condition and the storage location for the next set', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '10294');
    await wait(1100);
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
    expect(field('set').value).toBe('');
    expect(document.activeElement).toBe(field('set'));
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

  it('[ITEM-7] [ITEM-9] the photo strip adds photos, makes one the cover by moving it first, moves and removes them, and the save queues them in that order', async () => {
    answer = () => Response.json({ status: 'unavailable' });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '21318-1');
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
    await type('set', '10294');
    await wait(1100);
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
    const search = field('set');
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
        await type('set', '99902-1');
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
    await type('set', '99901');
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toHaveLength(1);
    expect(document.activeElement).toBe(field('set'));

    // A double tap, or the keyboard's Go in the focused set number, submits the emptied form again.
    await act(async () => container.querySelector('form')?.requestSubmit());
    await settle();
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('.field__error')).toHaveLength(0);
    expect(await queued()).toHaveLength(1);
  });

  it('[ITEM-9] [SYNC-6] takes the typed set number in the same field and makes no request, before or after it saves', async () => {
    await render(createElement(EntryForm, { mode: 'offline' }));
    await type('set', '10294');
    await chooseCondition('Sealed');
    await wait(1100);
    await click(button(en.form.saveAndNext));
    expect((await queued())[0]?.input).toMatchObject({ setNum: '10294-1', condition: 'SEALED' });
    expect(requests).toEqual([]);
  });

  it('[ITEM-9] [SYNC-6] prerenders /offline with the one set field, from no server data', () => {
    const html = renderToStaticMarkup(createElement(offlinePage.default));
    expect(html).toContain('name="set"');
    expect(html).not.toContain('class="results"');
    expect(html).not.toContain(en.form.delete);
    expect(html).toContain('Save &amp; add next');
  });
});

describe('an item that is not a set (#202)', () => {
  const kindChecked = (kind: string) => container.querySelector<HTMLInputElement>(`input[name="kind"][value="${kind}"]`)?.checked;

  it('[ITEM-9] [ITEM-10] offers to log a typed name as a minifigure, a bulk lot or another item, prefills the name, and saves it with no set number', async () => {
    answer = () => Response.json({ status: 'ok', sets: [] });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', 'Made-up pirate captain');
    await wait(600);
    expect(container.textContent).toContain(en.form.kind.logAs);
    // A set number offers no such choice: it saves as a set.
    await type('set', '10294');
    expect(container.textContent).not.toContain(en.form.kind.logAs);
    await type('set', 'Made-up pirate captain');
    await click(button(en.form.kind.MINIFIG));

    expect(container.querySelector('[name="set"]')).toBeNull();
    expect(kindChecked('MINIFIG')).toBe(true);
    expect(field('name').value).toBe('Made-up pirate captain');
    expect(document.activeElement).toBe(field('name'));
    // Completeness and instructions start unstated for a non-set.
    expect(container.querySelector<HTMLInputElement>('input[name="complete"][value="unstated"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[name="hasInstructions"][value="unstated"]')?.checked).toBe(true);
    expect(container.querySelector('[name="approxParts"]')).toBeNull();
    await type('refNo', 'mu0001');
    await chooseCondition('Used, no box');
    await type('storageLocation', 'Made-up drawer 2');
    await click(button(en.form.saveAndNext));

    const [entry] = await queued();
    expect(entry?.name).toBe(ITEM_MUTATION.save);
    expect(entry?.input).toEqual({
      id: expect.any(String),
      baseVersion: null,
      kind: 'MINIFIG',
      name: 'Made-up pirate captain',
      refNo: 'mu0001',
      condition: 'USED_NO_BOX',
      complete: null,
      hasInstructions: null,
      description: '',
      quantity: 1,
      storageLocation: 'Made-up drawer 2',
    });
    expect(container.querySelector('.toast')?.textContent).toBe('Saved Made-up pirate captain · 0 photos');

    // Save & add next keeps the kind, the condition and the storage location, and clears the rest.
    expect(kindChecked('MINIFIG')).toBe(true);
    expect(field('name').value).toBe('');
    expect(field('refNo').value).toBe('');
    expect(field('storageLocation').value).toBe('Made-up drawer 2');
    expect(container.querySelector<HTMLInputElement>('input[name="condition"][value="USED_NO_BOX"]')?.checked).toBe(true);
    expect(document.activeElement).toBe(field('name'));
    // A second submit straight after it does nothing and flags nothing.
    await click(button(en.form.saveAndNext));
    expect(await queued()).toHaveLength(1);
    expect(container.querySelectorAll('.field__error')).toHaveLength(0);
  });

  it('[ITEM-9] [ITEM-10] [SYNC-6] Not a set? beside the field logs a bulk lot on the offline shell, with its two numbers checked inline, and sends no request', async () => {
    await render(createElement(EntryForm, { mode: 'offline' }));
    await click(button(en.form.search.notASet));
    await chooseCondition(en.form.kind.BULK);
    expect(kindChecked('BULK')).toBe(true);
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toEqual([]);
    expect(container.querySelector('#name-problem')?.textContent).toBe(en.form.problems.required);

    await type('name', 'Made-up mixed bricks');
    await type('approxParts', '0');
    await type('approxWeightG', '10000001');
    await click(button(en.form.saveAndNext));
    expect(await queued()).toEqual([]);
    expect(container.querySelector('#approxParts-problem')?.textContent).toBe(en.form.problems.pieces);
    expect(container.querySelector('#approxWeightG-problem')?.textContent).toBe(en.form.problems.weight);

    await type('approxParts', '2500');
    await type('approxWeightG', '3200');
    await click(button(en.form.saveAndNext));
    expect((await queued())[0]?.input).toMatchObject({ kind: 'BULK', name: 'Made-up mixed bricks', approxParts: 2500, approxWeightG: 3200, refNo: null, complete: null });
    expect((await queued())[0]?.input).not.toHaveProperty('setNum');
    expect(kindChecked('BULK')).toBe(true);
    expect(field('approxParts').value).toBe('');
    expect(requests).toEqual([]);
  });

  it('[ITEM-9] It’s a set goes back to the set field, with the name as its text and the yes/no fields a set’s', async () => {
    answer = () => Response.json({ status: 'ok', sets: [] });
    await render(createElement(EntryForm, { mode: 'new' }));
    await click(button(en.form.search.notASet));
    await type('name', '99931');
    await click(button(en.form.kind.backToSet));
    expect(field('set').value).toBe('99931');
    expect(container.querySelector('[name="name"]')).toBeNull();
    expect(container.querySelector('input[name="complete"][value="unstated"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="complete"][value="yes"]')?.checked).toBe(true);
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    expect((await queued())[0]?.input).toMatchObject({ kind: 'SET', setNum: '99931-1', complete: true, hasInstructions: true });
  });

  it('[ITEM-9] [ITEM-10] an edit of a bulk lot opens as one, with its fields, and saves with its version', async () => {
    const item: EditableItem = {
      id: randomUUID(),
      version: 2,
      kind: 'BULK',
      set: null,
      name: 'Made-up mixed bricks',
      refNo: null,
      approxParts: 2500,
      approxWeightG: null,
      condition: 'USED_NO_BOX',
      complete: null,
      missingNotes: null,
      hasInstructions: false,
      description: '',
      quantity: 1,
      storageLocation: 'Made-up attic',
      photos: [],
    };
    await render(createElement(EntryForm, { mode: 'edit', item }));
    expect(kindChecked('BULK')).toBe(true);
    expect(field('name').value).toBe('Made-up mixed bricks');
    expect(field('approxParts').value).toBe('2500');
    expect(container.querySelector<HTMLInputElement>('input[name="hasInstructions"][value="no"]')?.checked).toBe(true);
    await type('approxWeightG', '1800');
    await click(button(en.form.save));
    expect((await queued())[0]?.input).toMatchObject({ id: item.id, baseVersion: 2, kind: 'BULK', approxParts: 2500, approxWeightG: 1800, hasInstructions: false, complete: null });
  });
});

describe('the edit form', () => {
  const photoId = randomUUID();
  const item: EditableItem = {
    id: randomUUID(),
    version: 5,
    kind: 'SET',
    set: SET,
    name: null,
    refNo: null,
    approxParts: null,
    approxWeightG: null,
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

  it('[ITEM-8] [ITEM-9] Save shows the items only once its own sync has answered, so the list holds the set', async () => {
    holdSync = true;
    answer = () => Response.json({ status: 'unavailable' });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '99921-1');
    await chooseCondition('Sealed');
    await click(button(en.form.save));
    expect(await queued()).toHaveLength(1);
    // The sync hasn't answered yet: the form stays, so the server can't draw the list without the set.
    await wait(50);
    expect(assign).not.toHaveBeenCalled();
    await act(async () => announceSynced());
    await settle();
    expect(assign).toHaveBeenCalledWith('/admin');
  });

  it('[ITEM-9] Save offline shows the items at once, where the set waits as not synced', async () => {
    holdSync = true;
    setOnline(false);
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '99922-1');
    await chooseCondition('Sealed');
    await click(button(en.form.save));
    expect(assign).toHaveBeenCalledWith('/admin');
  });

  it('[ITEM-9] puts Delete at the top of the edit form, as quiet text, never in the action bar beside Save', async () => {
    await render(createElement(EntryForm, { mode: 'edit', item }));
    const remove = button(en.form.delete);
    expect(remove.closest('.action-bar')).toBeNull();
    expect(remove.className).toContain('button--quiet-danger');
    const form = container.querySelector('form');
    const firstField = form?.querySelector('input, textarea, select');
    // Delete comes before every field in the form, so it is never near the save at the bottom.
    expect(firstField).not.toBeNull();
    expect(remove.compareDocumentPosition(firstField as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

describe('Save’s progress', () => {
  it('[SYNC-12] shows a progress bar with the photos uploaded while Save waits for its sync, then Saving…, then the items (#203)', async () => {
    holdSync = true;
    answer = () => Response.json({ status: 'unavailable' });
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '99923-1');
    await chooseCondition('Sealed');
    expect(container.querySelector('.save-progress')).toBeNull();
    await click(button(en.form.save));
    const progress = (uploaded: number, total: number) => act(async () => void window.dispatchEvent(new CustomEvent(QUEUE_PROGRESS, { detail: { uploaded, total } })));
    await progress(0, 8);
    await progress(3, 8);
    const bar = container.querySelector<HTMLProgressElement>('.save-progress progress');
    expect(bar?.getAttribute('max')).toBe('8');
    expect(bar?.getAttribute('value')).toBe('3');
    expect(container.querySelector('.save-progress')?.textContent).toBe(en.form.uploadingPhotos(3, 8));
    expect(container.querySelector('.save-progress')?.textContent).toBe('Uploading photos 3 of 8');

    // Every photo is up: the server is storing the batch, and the bar has no value to show.
    await progress(8, 8);
    expect(container.querySelector('.save-progress')?.textContent).toBe(en.form.saving);
    expect(container.querySelector('.save-progress progress')?.hasAttribute('value')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    await act(async () => announceSynced());
    await settle();
    expect(assign).toHaveBeenCalledWith('/admin');
  });

  it('[SYNC-12] shows no progress for Save & add next, which doesn’t wait', async () => {
    await render(createElement(EntryForm, { mode: 'new' }));
    await type('set', '99924-1');
    await chooseCondition('Sealed');
    await click(button(en.form.saveAndNext));
    await act(async () => void window.dispatchEvent(new CustomEvent(QUEUE_PROGRESS, { detail: { uploaded: 1, total: 2 } })));
    expect(container.querySelector('.save-progress')).toBeNull();
  });
});
