// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openQueue } from '../../../src/app/_offline/queue';
import { en } from '../../../src/app/messages/en';

/**
 * The browser components of offline entry, rendered in a DOM with an IndexedDB stand-in:
 * the queue's panel on `/admin` and `/offline` ([SYNC-7], [SYNC-8]), the service worker's
 * registration ([SYNC-5]), the sign-out button ([SYNC-9]) and the header's word on the public
 * catalogue after a synced delete ([PUB-16], #192).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QueuePanel, ServiceWorkerRegistration, SignOutButton } = await import('../../../src/app/_offline/client');
const { Header } = await import('../../../src/app/_admin/chrome');

let root: Root;
let container: HTMLElement;
let sent: string[][];
let answer: (name: string) => Record<string, unknown>;
let status: number;
/** The sync answer's `catalogue`, as the server sets it after a batch's deletes (#187); undefined leaves it out. */
let catalogue: string | undefined;
const persist = vi.fn(async () => true);
const register = vi.fn(async () => ({}));
const postMessage = vi.fn();

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  sent = [];
  status = 200;
  catalogue = undefined;
  sessionStorage.clear();
  answer = () => ({ outcome: 'applied', result: null });
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if (status !== 200) return new Response(null, { status });
    const { mutations } = JSON.parse(String(init.body)) as { mutations: { id: string; name: string }[] };
    sent.push(mutations.map((mutation) => mutation.name));
    return Response.json({ outcomes: mutations.map((mutation) => ({ id: mutation.id, ...answer(mutation.name) })), ...(catalogue === undefined ? {} : { catalogue }) });
  });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist } });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register, ready: Promise.resolve({ active: { postMessage } }) },
  });
  setOnline(true);
  persist.mockClear();
  register.mockClear();
  postMessage.mockClear();
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

async function queued(...names: string[]): Promise<void> {
  const queue = await openQueue(indexedDB);
  for (const name of names) await queue.enqueue({ name, input: {} });
  queue.close();
}

async function pending(): Promise<string[]> {
  const queue = await openQueue(indexedDB);
  try {
    return (await queue.entries()).map((entry) => entry.name);
  } finally {
    queue.close();
  }
}

/** Renders, then lets IndexedDB and the replay settle. */
async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root.render(element));
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

/** Stands in for the browser's confirm dialog, answering it as the admin would. */
function answerConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
  return confirm;
}

function theForm(): HTMLFormElement {
  const form = container.querySelector('form');
  if (form === null) throw new Error('no form');
  return form;
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

describe('the queue panel', () => {
  it('[SYNC-7] replays the queue when the admin opens, asks for persistent storage, and refreshes the shell', async () => {
    await queued('test.first', 'test.second');
    await render(createElement(QueuePanel));
    expect(sent).toEqual([['test.first', 'test.second']]);
    expect(await pending()).toEqual([]);
    expect(persist).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'refresh-shell' });
    expect(container.textContent).toContain('No changes are waiting to sync.');
  });

  it('[SYNC-7] waits while offline, then replays when the network returns', async () => {
    setOnline(false);
    await queued('test.first');
    await render(createElement(QueuePanel));
    expect(sent).toEqual([]);
    expect(container.textContent).toContain('1 change is waiting to sync.');
    setOnline(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    await settle();
    expect(sent).toEqual([['test.first']]);
    expect(await pending()).toEqual([]);
  });

  it('[SYNC-8] lists a held mutation with retry and discard; a retry sends it again, a discard drops it and sends the rest', async () => {
    await queued('test.first', 'test.second');
    answer = (name) => (name === 'test.first' ? { outcome: 'invalid', issues: ['input: made-up issue'] } : { outcome: 'applied', result: null });
    await render(createElement(QueuePanel));
    expect(container.textContent).toContain('2 changes are waiting to sync.');
    expect(container.textContent).toContain('test.first');
    expect(container.textContent).toContain('input: made-up issue');

    await act(async () => button('Retry').click());
    await settle();
    expect(sent).toEqual([['test.first', 'test.second'], ['test.first', 'test.second']]);

    answerConfirm(true);
    await act(async () => button('Discard').click());
    await settle();
    expect(sent.at(-1)).toEqual(['test.second']);
    expect(await pending()).toEqual([]);
  });

  it('[SYNC-8] retries a failed mutation by itself when the network returns, without asking the admin', async () => {
    await queued('test.first', 'test.second');
    let failures = 1;
    answer = (name) => (name === 'test.first' && failures-- > 0 ? { outcome: 'failed', requestId: 'made-up-request-id' } : { outcome: 'applied', result: null });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T12:00:00Z'));
    await render(createElement(QueuePanel));
    expect(container.textContent).toContain('2 changes are waiting to sync.');
    expect(container.textContent).toContain('tried again');
    expect([...container.querySelectorAll('button')]).toEqual([]);
    clock.mockReturnValue(Date.parse('2026-11-01T12:00:00Z') + 30 * 60_000);
    await act(async () => window.dispatchEvent(new Event('online')));
    await settle();
    expect(sent).toEqual([['test.first', 'test.second'], ['test.first', 'test.second']]);
    expect(await pending()).toEqual([]);
  });

  it('[SYNC-8] keeps a held mutation when the admin cancels its discard', async () => {
    await queued('test.first');
    answer = () => ({ outcome: 'conflict', reason: 'version', currentVersion: 2, current: null });
    await render(createElement(QueuePanel));
    answerConfirm(false);
    await act(async () => button('Discard').click());
    await settle();
    expect(await pending()).toEqual(['test.first']);
    expect(container.textContent).toContain('the record changed on the server');
  });

  it('[SYNC-8] [ITEM-7] discards a held set with its photos, naming them, and keeps a later change', async () => {
    const queue = await openQueue(indexedDB);
    await queue.enqueueAll([
      { name: 'saveItem', input: { id: 'made-up-item', setNum: '10294-1' } },
      { name: 'registerPhoto', input: {} },
      { name: 'registerPhoto', input: {} },
      { name: 'registerPhoto', input: {} },
    ]);
    await queue.enqueue({ name: 'test.later', input: {} });
    queue.close();
    answer = (name) => (name === 'saveItem' ? { outcome: 'invalid', issues: ['setNum: made-up'], code: 'unknown-set' } : { outcome: 'applied', result: null });
    await render(createElement(QueuePanel));
    expect(container.textContent).toContain('Set number not found. Discard it and its photos');
    const confirm = answerConfirm(true);
    await act(async () => button('Discard').click());
    await settle();
    expect(confirm).toHaveBeenCalledWith('Discard 10294-1 and its 3 photos? None of it will sync.');
    // The photos rode only in the first batch, behind the held set, answered as not attempted.
    // After the discard none of them is sent again; the later change syncs on its own.
    expect(sent[0]).toEqual(['saveItem', 'registerPhoto', 'registerPhoto', 'registerPhoto', 'test.later']);
    expect(sent.slice(1)).toEqual([['test.later']]);
    expect(await pending()).toEqual([]);
  });

  it('[SYNC-8] sends the admin to the login when the session has ended, keeping the queue', async () => {
    await queued('test.first');
    status = 401;
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
    await render(createElement(QueuePanel));
    expect(assign).toHaveBeenCalledWith('/login');
    expect(await pending()).toEqual(['test.first']);
  });
});

describe('the public catalogue after a synced delete (#192)', () => {
  /** An admin page: its header, and the queue's panel that syncs. */
  const page = () => createElement(Fragment, null, createElement(Header, { title: 'Page' }), createElement(QueuePanel));

  /** Opens another page, as a navigation or a reload does: the old one goes, a new one renders. */
  async function nextPage(): Promise<void> {
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(page());
  }

  const notice = () => container.querySelector('.catalogue-notice');

  it('[PUB-16] tells the admin to press Publish when the republish after a synced delete failed, on every page until they dismiss it', async () => {
    await queued('deleteItem');
    catalogue = 'stale';
    await render(page());
    expect(sent).toEqual([['deleteItem']]);
    expect(notice()?.getAttribute('role')).toBe('alert');
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.stale);

    // The set's Delete goes back to the items, and a sync that applies something reloads the list.
    catalogue = undefined;
    await nextPage();
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.stale);
    await nextPage();
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.stale);

    await act(async () => button(en.catalogueAfterDelete.dismiss).click());
    expect(notice()).toBeNull();
    await nextPage();
    expect(notice()).toBeNull();
  });

  it('[PUB-16] says a synced delete left the public catalogue, on its page and on the next one it opens, then no more', async () => {
    await queued('deletePhoto');
    catalogue = 'updated';
    await render(page());
    expect(notice()?.getAttribute('role')).toBe('status');
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.updated);

    catalogue = undefined;
    await nextPage();
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.updated);
    await nextPage();
    expect(notice()).toBeNull();
  });

  it('[PUB-16] a later sync\'s outcome replaces an earlier one', async () => {
    await queued('deleteItem');
    catalogue = 'stale';
    await render(page());
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.stale);

    await queued('deletePhoto');
    catalogue = 'updated';
    await nextPage();
    expect(notice()?.textContent).toContain(en.catalogueAfterDelete.updated);
    expect(notice()?.textContent).not.toContain(en.catalogueAfterDelete.stale);
  });

  it('[PUB-16] says nothing when no catalogue is published, or the sync deleted nothing', async () => {
    await queued('deleteItem');
    catalogue = 'not-published';
    await render(page());
    expect(sent).toEqual([['deleteItem']]);
    expect(notice()).toBeNull();

    await queued('saveItem');
    catalogue = undefined;
    await nextPage();
    expect(sent).toEqual([['deleteItem'], ['saveItem']]);
    expect(notice()).toBeNull();
  });
});

describe('the service worker registration', () => {
  it('[SYNC-5] registers /sw.js for the whole admin, checking it for updates past the HTTP cache', async () => {
    await render(createElement(ServiceWorkerRegistration));
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });
});

describe('the sign-out button', () => {
  it('[SYNC-9] warns with the count, then clears the queue and the caches before it posts the logout', async () => {
    await queued('test.first', 'test.second');
    setOnline(false);
    await render(createElement(SignOutButton));
    setOnline(true);
    const names = new Set(['plinthos-shell-v1']);
    vi.stubGlobal('caches', { keys: async () => [...names], delete: async (name: string) => names.delete(name) });
    const confirm = answerConfirm(true);
    const form = theForm();
    expect(form.getAttribute('action')).toBe('/admin/logout');
    expect(form.getAttribute('method')).toBe('post');
    const submit = vi.spyOn(form, 'submit').mockImplementation(() => undefined);
    await act(async () => button('Sign out').click());
    await settle();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^2 changes have not been synced yet\./));
    expect(await pending()).toEqual([]);
    expect(names.size).toBe(0);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('[SYNC-9] does not sign out when the admin declines, and keeps the queue', async () => {
    await queued('test.first');
    await render(createElement(SignOutButton));
    answerConfirm(false);
    const form = theForm();
    const submit = vi.spyOn(form, 'submit').mockImplementation(() => undefined);
    await act(async () => button('Sign out').click());
    await settle();
    expect(submit).not.toHaveBeenCalled();
    expect(await pending()).toEqual(['test.first']);
  });

  it('[SYNC-9] warns, deletes the queue and only then posts the logout, when IndexedDB is there but the queue fails to open', async () => {
    await queued('test.first');
    await render(createElement(SignOutButton));
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('made-up connection failure', 'UnknownError');
    });
    const confirm = answerConfirm(true);
    const form = theForm();
    const submit = vi.spyOn(form, 'submit').mockImplementation(() => undefined);
    await act(async () => button('Sign out').click());
    await settle();
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/could not be opened/));
    expect(submit).toHaveBeenCalledTimes(1);
    open.mockRestore();
    expect(await pending()).toEqual([]);
  });

  it('[SYNC-9] tells the admin they are still signed in, and does not post the logout, when clearing the caches fails (#99)', async () => {
    await render(createElement(SignOutButton));
    vi.stubGlobal('caches', {
      keys: async () => {
        throw new DOMException('made-up Cache Storage failure', 'UnknownError');
      },
    });
    const alert = vi.fn();
    Object.defineProperty(window, 'alert', { configurable: true, writable: true, value: alert });
    const form = theForm();
    const submit = vi.spyOn(form, 'submit').mockImplementation(() => undefined);
    await act(async () => button('Sign out').click());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/still signed in/));
    expect(submit).not.toHaveBeenCalled();
  });
});
