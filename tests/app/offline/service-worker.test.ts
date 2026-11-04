import { describe, expect, it } from 'vitest';
import { GET, dynamic } from '../../../src/app/sw.js/route';
import { SHELL_CACHE, SHELL_PRECACHE } from '../../../src/app/_offline/shell';
import { adminServer, ORIGIN, WorkerHarness, type PageRequest } from './worker-harness';

/**
 * `[SYNC-5]` and `[SYNC-6]`: the service worker `/sw.js` serves, run from that very script.
 * `docs/qa/stack.md`'s `## Data isolation` holds this file: the worker must never cache an
 * authenticated response.
 */

const SHELL = `${ORIGIN}/offline`;
const SHELL_FILES = [
  SHELL,
  `${ORIGIN}/_next/static/css/shell-a1.css`,
  `${ORIGIN}/_next/static/chunks/main-b2.js`,
  `${ORIGIN}/_next/static/chunks/page-c3.js`,
  ...SHELL_PRECACHE.map((path) => `${ORIGIN}${path}`),
].sort();

/** Every request a page of the admin can make, signed in, as the browser hands it to the worker. */
const PAGE_REQUESTS: PageRequest[] = [
  { url: '/admin', mode: 'navigate' },
  { url: '/admin?tab=queue', mode: 'navigate' },
  { url: '/login', mode: 'navigate' },
  { url: '/offline', mode: 'navigate' },
  { url: '/admin/api/sync', mode: 'cors', credentials: 'same-origin' },
  { url: '/admin/api/sync', method: 'POST', mode: 'cors', credentials: 'same-origin' },
  { url: '/admin/api/sets/search?q=made-up', mode: 'cors', credentials: 'same-origin' },
  // The set index ([CAT-10]): the device keeps its own copy in IndexedDB, never in a cache.
  { url: '/admin/api/sets/index', mode: 'cors', credentials: 'same-origin' },
  { url: '/admin/logout', method: 'POST', mode: 'navigate' },
  { url: '/_next/static/chunks/main-b2.js' },
  { url: '/_next/static/chunks/not-in-the-shell-d4.js' },
  { url: '/manifest.webmanifest', mode: 'cors', credentials: 'include' },
  { url: '/admin/photos/thumb.webp' },
  { url: 'https://elsewhere.example.test/_next/static/chunks/main-b2.js', mode: 'cors' },
];

/**
 * The [SYNC-6] rule over everything the worker cached: only shell paths, never one under
 * `/admin`, and each fetched by the worker itself without credentials, as a same-origin request.
 */
function expectOnlyTheShell(harness: WorkerHarness): void {
  const stored = harness.stored();
  expect(stored.length).toBeGreaterThan(0);
  for (const entry of stored) {
    const url = new URL(entry.url);
    expect(url.origin, entry.url).toBe(ORIGIN);
    expect(url.pathname === '/admin' || url.pathname.startsWith('/admin/'), `${entry.url} is an admin route`).toBe(false);
    const shellPath = url.pathname === '/offline' || url.pathname.startsWith('/_next/static/') || SHELL_PRECACHE.includes(url.pathname);
    expect(shellPath && url.search === '', `${entry.url} is not part of the shell`).toBe(true);
    expect(entry.fetchedWith, `${entry.url} was stored from a response the worker did not fetch itself`).toBeDefined();
    expect(entry.fetchedWith?.credentials, `${entry.url} was fetched with credentials`).toBe('omit');
    expect(entry.response.headers.get('cache-control') ?? '').not.toMatch(/no-store|private/);
  }
}

describe('the script /sw.js serves', () => {
  it('[SYNC-5] is a prerendered script that asks to be checked each time, the same for everyone', async () => {
    expect(dynamic).toBe('force-static');
    const response = GET();
    expect(response.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('set-cookie')).toBeNull();
    const script = await response.text();
    expect(script).toContain(JSON.stringify(SHELL_CACHE));
    expect(script).not.toMatch(/import\s|require\(/);
  });

  it('[SYNC-5] runs on its own, reaching nothing outside its source, and listens for its four events', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    expect(harness.skippedWaiting).toBe(true);
    await harness.activate();
    expect(harness.claimed).toBe(true);
  });
});

describe('installing the worker', () => {
  it('[SYNC-5] [SYNC-6] precaches the shell, the static assets it loads and the manifest files, all without credentials', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    expect([...harness.caches.keys()]).toEqual([SHELL_CACHE]);
    expect(harness.stored().map((entry) => entry.url).sort()).toEqual(SHELL_FILES);
    for (const request of harness.sent) expect(request.credentials, request.url).toBe('omit');
    expectOnlyTheShell(harness);
  });

  it('[SYNC-5] fails, keeping nothing, when the shell cannot be fetched', async () => {
    const harness = await new WorkerHarness(adminServer({ '/offline': () => new Response('down', { status: 503 }) })).load();
    await expect(harness.install()).rejects.toThrow(/shell/);
    expect(harness.stored()).toEqual([]);
  });

  it('[SYNC-6] refuses to keep a shell or an asset the server marks no-store or private, a redirect, or an /admin path the shell names', async () => {
    const privateAsset = () => new Response('x', { headers: { 'cache-control': 'private, max-age=60' } });
    const redirected = () => {
      const response = new Response('x');
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    };
    const harness = await new WorkerHarness(
      adminServer({
        '/offline': () =>
          new Response('<script src="/_next/static/chunks/main-b2.js"></script><script src="/_next/static/chunks/page-c3.js"></script><img src="/admin/static/media/x.png">', {
            headers: { 'content-type': 'text/html' },
          }),
        '/_next/static/chunks/main-b2.js': privateAsset,
        '/_next/static/chunks/page-c3.js': redirected,
        '/manifest.webmanifest': () => new Response('{}', { headers: { 'cache-control': 'no-store' } }),
      }),
    ).load();
    await harness.install();
    const urls = harness.stored().map((entry) => entry.url);
    expect(urls).toContain(SHELL);
    for (const refused of ['/_next/static/chunks/main-b2.js', '/_next/static/chunks/page-c3.js', '/manifest.webmanifest', '/admin/static/media/x.png']) {
      expect(urls).not.toContain(`${ORIGIN}${refused}`);
    }
    expectOnlyTheShell(harness);

    const noStoreShell = await new WorkerHarness(adminServer({ '/offline': () => new Response('<p></p>', { headers: { 'cache-control': 'no-store' } }) })).load();
    await expect(noStoreShell.install()).rejects.toThrow(/shell/);
    expect(noStoreShell.stored()).toEqual([]);
  });
});

describe('the fetch handler', () => {
  it('[SYNC-6] caches nothing the admin\'s pages request, signed in or not, online or offline', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    const before = harness.stored().map((entry) => entry.url).sort();
    for (const online of [true, false]) {
      harness.online = online;
      for (const request of PAGE_REQUESTS) await harness.fetch(request).catch(() => undefined);
    }
    expect(harness.stored().map((entry) => entry.url).sort()).toEqual(before);
    expectOnlyTheShell(harness);
  });

  it('[SYNC-6] lets every admin route and every other origin through to the network, untouched', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    for (const request of [
      { url: '/admin/api/sync', mode: 'cors', credentials: 'same-origin' },
      { url: '/admin/api/sync', method: 'POST', mode: 'cors', credentials: 'same-origin' },
      { url: '/admin/api/sets/index', mode: 'cors', credentials: 'same-origin' },
      { url: '/admin/photos/thumb.webp' },
      { url: '/admin/logout', method: 'POST', mode: 'navigate' },
      { url: 'https://elsewhere.example.test/x.js' },
    ] as PageRequest[]) {
      expect(await harness.fetch(request), request.url).toBeUndefined();
    }
  });

  it('[SYNC-5] sends a navigation to the network while there is one, and never stores the page', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    const response = await harness.fetch({ url: '/admin', mode: 'navigate' });
    expect(await response?.text()).toContain('private');
    expect(harness.sent.at(-1)).toMatchObject({ url: `${ORIGIN}/admin`, credentials: 'include' });
    expect(harness.stored().map((entry) => entry.url)).not.toContain(`${ORIGIN}/admin`);
  });

  it('[SYNC-5] opens an installed admin with no network to its shell: /admin goes to /offline, which comes from the cache with its assets', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    harness.online = false;
    const start = await harness.fetch({ url: '/admin', mode: 'navigate' });
    expect(start?.status).toBe(302);
    expect(start?.headers.get('location')).toBe(SHELL);
    const shell = await harness.fetch({ url: '/offline', mode: 'navigate' });
    expect(shell?.status).toBe(200);
    expect(await shell?.text()).toContain('/_next/static/chunks/main-b2.js');
    const asset = await harness.fetch({ url: '/_next/static/chunks/main-b2.js' });
    expect(await asset?.text()).toBe('/* main */');
  });

  it('[SYNC-5] answers a static asset from the cache before the network, and one not cached from the network without storing it', async () => {
    const harness = await new WorkerHarness(adminServer({ '/_next/static/chunks/late-e5.js': () => new Response('/* late */') })).load();
    await harness.install();
    const sentBefore = harness.sent.length;
    expect(await (await harness.fetch({ url: '/_next/static/chunks/main-b2.js' }))?.text()).toBe('/* main */');
    expect(harness.sent.length).toBe(sentBefore);
    expect(await (await harness.fetch({ url: '/_next/static/chunks/late-e5.js' }))?.text()).toBe('/* late */');
    expect(harness.stored().map((entry) => entry.url)).not.toContain(`${ORIGIN}/_next/static/chunks/late-e5.js`);
  });
});

describe('keeping the shell current', () => {
  it('[SYNC-5] refreshes the shell when an admin page asks, dropping the assets the new shell no longer loads', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    harness.routes = adminServer({
      '/offline': () => new Response('<script src="/_next/static/chunks/main-f6.js"></script>', { headers: { 'content-type': 'text/html' } }),
      '/_next/static/chunks/main-f6.js': () => new Response('/* new main */'),
    });
    await harness.message({ type: 'refresh-shell' });
    const urls = harness.stored().map((entry) => entry.url);
    expect(urls).toContain(`${ORIGIN}/_next/static/chunks/main-f6.js`);
    expect(urls).not.toContain(`${ORIGIN}/_next/static/chunks/main-b2.js`);
    expectOnlyTheShell(harness);
  });

  it('[SYNC-5] keeps the shell it has when a refresh finds no network', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    harness.online = false;
    await harness.message({ type: 'refresh-shell' });
    expect(harness.stored().map((entry) => entry.url).sort()).toEqual(SHELL_FILES);
  });

  it('[SYNC-5] deletes an older version\'s caches when it activates, and keeps other caches of the origin', async () => {
    const harness = await new WorkerHarness().load();
    await harness.install();
    const shell = harness.caches.get(SHELL_CACHE);
    expect(shell).toBeDefined();
    if (shell === undefined) return;
    harness.caches.set('plinthos-shell-v0', shell);
    harness.caches.set('someone-else', shell);
    await harness.activate();
    expect([...harness.caches.keys()].sort()).toEqual([SHELL_CACHE, 'someone-else'].sort());
  });
});
