// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextSync, QUEUE_PROGRESS, QUEUE_STATE, SAVE_SYNC_CAP_MS, SAVE_SYNC_WAIT_MS, StatusChip, type UploadProgress } from '../../../src/app/_offline/client';
import { PRESIGN_ENDPOINT, queuePhoto } from '../../../src/app/_offline/photos';
import { openQueue } from '../../../src/app/_offline/queue';
import { replayQueue, SYNC_ENDPOINT } from '../../../src/app/_offline/replay';
import { en } from '../../../src/app/messages/en';

/**
 * `[SYNC-12]` (#203): the replay's upload progress as the browser sees it, the window event
 * `QUEUE_PROGRESS`; the header's chip, which shows it compactly; and Save's wait for its sync,
 * which each photo uploaded rearms, up to a cap. Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S3_URL = 'https://photos.fake-s3.test/';

function progress(uploaded: number, total: number): void {
  window.dispatchEvent(new CustomEvent<UploadProgress>(QUEUE_PROGRESS, { detail: { uploaded, total } }));
}

function synced(): void {
  window.dispatchEvent(new CustomEvent(QUEUE_STATE, { detail: { status: 'synced', entries: [], applied: 1 } }));
}

/** Whether `promise` has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('the replay’s upload progress', () => {
  it('[SYNC-12] reaches the window as QUEUE_PROGRESS events when the replay is given no reporter of its own', async () => {
    const queue = await openQueue(new IDBFactory());
    await queuePhoto(queue, new Uint8Array([1, 2, 3]).buffer);
    await queuePhoto(queue, new Uint8Array([4, 5, 6]).buffer);
    let key = 0;
    const fake = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      if (String(url) === PRESIGN_ENDPOINT) {
        const made = `quarantine/made-up-${++key}`;
        return Response.json({ key: made, url: S3_URL, fields: { key: made }, maxBytes: 1024, expiresAt: new Date().toISOString() });
      }
      if (String(url) === S3_URL) return new Response(null, { status: 204 });
      if (String(url) === SYNC_ENDPOINT) {
        const { mutations } = JSON.parse(String(init.body)) as { mutations: { id: string }[] };
        return Response.json({ outcomes: mutations.map((mutation) => ({ id: mutation.id, outcome: 'applied', result: null })) });
      }
      throw new Error(`unexpected request to ${String(url)}`);
    };
    const seen: UploadProgress[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<UploadProgress>).detail);
    window.addEventListener(QUEUE_PROGRESS, listen);
    try {
      expect((await replayQueue(queue, { fetch: fake as typeof fetch })).status).toBe('synced');
    } finally {
      window.removeEventListener(QUEUE_PROGRESS, listen);
    }
    expect(seen).toEqual([
      { uploaded: 0, total: 2 },
      { uploaded: 1, total: 2 },
      { uploaded: 2, total: 2 },
    ]);
  });
});

describe('Save’s wait for its sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('[SYNC-12] ends when the sync answers, or after SAVE_SYNC_WAIT_MS when no progress arrives', async () => {
    const answered = nextSync(SAVE_SYNC_WAIT_MS);
    synced();
    expect(await settled(answered)).toBe(true);

    const quiet = nextSync(SAVE_SYNC_WAIT_MS);
    await vi.advanceTimersByTimeAsync(SAVE_SYNC_WAIT_MS - 1);
    expect(await settled(quiet)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(quiet)).toBe(true);
  });

  it('[SYNC-12] is rearmed by each photo uploaded, so a slow connection that is getting on keeps it waiting', async () => {
    const waiting = nextSync(SAVE_SYNC_WAIT_MS);
    progress(0, 8);
    for (let uploaded = 1; uploaded <= 4; uploaded++) {
      await vi.advanceTimersByTimeAsync(SAVE_SYNC_WAIT_MS - 1_000);
      expect(await settled(waiting)).toBe(false);
      progress(uploaded, 8);
    }
    // 4 × 7 s have passed, past the plain wait; the last photo uploaded rearmed it for another 8 s.
    await vi.advanceTimersByTimeAsync(SAVE_SYNC_WAIT_MS - 1);
    expect(await settled(waiting)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(waiting)).toBe(true);
  });

  it('[SYNC-12] waits on once the last photo is up, while the server stores the batch, but never past SAVE_SYNC_CAP_MS in all', async () => {
    const stored = nextSync(SAVE_SYNC_WAIT_MS);
    progress(0, 2);
    progress(2, 2);
    await vi.advanceTimersByTimeAsync(SAVE_SYNC_WAIT_MS * 3);
    expect(await settled(stored)).toBe(false);
    synced();
    expect(await settled(stored)).toBe(true);

    const capped = nextSync(SAVE_SYNC_WAIT_MS);
    for (let elapsed = 0; elapsed < SAVE_SYNC_CAP_MS - 5_000; elapsed += 5_000) {
      progress(elapsed / 5_000, 100);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(await settled(capped)).toBe(false);
    progress(50, 100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settled(capped)).toBe(true);
    expect(SAVE_SYNC_CAP_MS).toBe(60_000);

    const lastUp = nextSync(SAVE_SYNC_WAIT_MS);
    progress(1, 1);
    await vi.advanceTimersByTimeAsync(SAVE_SYNC_CAP_MS);
    expect(await settled(lastUp)).toBe(true);
  });
});

describe('the status chip', () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('[SYNC-12] shows "Uploading 3/8" while a sync uploads, then what the sync left', async () => {
    await act(async () => root.render(createElement(StatusChip)));
    expect(container.textContent).toContain(en.status.online);
    await act(async () => progress(3, 8));
    expect(container.textContent).toContain('Uploading 3/8');
    expect(container.textContent).toContain(en.status.uploading(3, 8));
    await act(async () => progress(8, 8));
    expect(container.textContent).not.toContain('Uploading');
    await act(async () => progress(1, 2));
    await act(async () => synced());
    expect(container.textContent).not.toContain('Uploading');
  });
});
