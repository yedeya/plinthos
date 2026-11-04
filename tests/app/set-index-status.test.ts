// @vitest-environment happy-dom
import { gzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SET_INDEX_ENDPOINT, STALE_AFTER_MS } from '../../src/app/_offline/set-index';
import { en } from '../../src/app/messages/en';

/**
 * `[CAT-10]`: `/admin` shows when the set index on the device was built, says so quietly when it is
 * older than 14 days, and asks the index's route once when it opens online. Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SetIndexStatus } = await import('../../src/app/_admin/set-index-status');

const VERSION = 'f'.repeat(64);

let root: Root;
let container: HTMLElement;
let indexRequests: (string | null)[];
let indexAnswer: () => Response;

function indexResponse(builtAt: string): Response {
  const body = gzipSync(JSON.stringify({ format: 1, builtAt, sources: { sets: null, themes: null, minifigs: null }, themes: [], sets: [['99901-1', 'Made-up set', 1, 2001, 10]], minifigs: [] }));
  return new Response(new Uint8Array(body), { headers: { etag: `"${VERSION}"`, 'content-type': 'application/gzip' } });
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  sessionStorage.clear();
  setOnline(true);
  indexRequests = [];
  indexAnswer = () => new Response('No set index has been built yet.', { status: 404 });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url) !== SET_INDEX_ENDPOINT) throw new Error(`unexpected request to ${url}`);
    indexRequests.push(new Headers(init?.headers).get('if-none-match'));
    return indexAnswer();
  });
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

async function render(): Promise<void> {
  await act(async () => root.render(createElement(SetIndexStatus)));
  for (let i = 0; i < 10; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

describe('the set index’s age on /admin', () => {
  it('[CAT-10] says when the index on the device was built, after asking the route once when the admin opens online', async () => {
    const builtAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    indexAnswer = () => indexResponse(builtAt);
    await render();
    expect(indexRequests).toEqual([null]);
    expect(container.textContent).toBe(en.setIndex.builtOn(builtAt));
    expect(container.textContent).not.toContain(en.setIndex.stale);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(indexRequests).toEqual([null]);
    expect(container.textContent).toBe(en.setIndex.builtOn(builtAt));
  });

  it('[CAT-10] says quietly when the index on the device is older than 14 days', async () => {
    const builtAt = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    indexAnswer = () => indexResponse(builtAt);
    await render();
    expect(container.textContent).toContain(en.setIndex.builtOn(builtAt));
    expect(container.textContent).toContain(en.setIndex.stale);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('[CAT-10] says the device holds no index yet, and asks nothing offline', async () => {
    setOnline(false);
    await render();
    expect(indexRequests).toEqual([]);
    expect(container.textContent).toBe(en.setIndex.none);
  });
});
