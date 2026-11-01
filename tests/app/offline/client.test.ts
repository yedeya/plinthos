// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openQueue } from '../../../src/app/_offline/queue';

/**
 * The browser components of offline entry, rendered in a DOM with an IndexedDB stand-in:
 * the queue's panel on `/admin` and `/offline` ([SYNC-7], [SYNC-8]), the service worker's
 * registration ([SYNC-5]) and the sign-out button ([SYNC-9]).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QueuePanel, ServiceWorkerRegistration, SignOutButton } = await import('../../../src/app/_offline/client');

let root: Root;
let container: HTMLElement;
let sent: string[][];
let answer: (name: string) => Record<string, unknown>;
let status: number;
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
  answer = () => ({ outcome: 'applied', result: null });
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if (status !== 200) return new Response(null, { status });
    const { mutations } = JSON.parse(String(init.body)) as { mutations: { id: string; name: string }[] };
    sent.push(mutations.map((mutation) => mutation.name));
    return Response.json({ outcomes: mutations.map((mutation) => ({ id: mutation.id, ...answer(mutation.name) })) });
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
    answer = (name) => (name === 'test.first' ? { outcome: 'failed', requestId: 'made-up-request-id' } : { outcome: 'applied', result: null });
    await render(createElement(QueuePanel));
    expect(container.textContent).toContain('2 changes are waiting to sync.');
    expect(container.textContent).toContain('test.first');
    expect(container.textContent).toContain('made-up-request-id');

    await act(async () => button('Retry').click());
    await settle();
    expect(sent).toEqual([['test.first', 'test.second'], ['test.first', 'test.second']]);

    answerConfirm(true);
    await act(async () => button('Discard').click());
    await settle();
    expect(sent.at(-1)).toEqual(['test.second']);
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
});
