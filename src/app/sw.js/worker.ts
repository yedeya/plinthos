/**
 * The admin's service worker ([SYNC-5], [SYNC-6]), as one self-contained function that
 * `./route.ts` serves as the script at `/sw.js`.
 *
 * It keeps one cache, the app shell: the data-free document at `/offline`, the static build
 * assets that document loads, and the manifest's icons. Nothing else is ever stored:
 *
 * - **Only its own credential-free requests are cached.** Every cached response is one the worker
 *   fetched itself with `credentials: 'omit'`, so no response to a request that carried the
 *   session cookie can reach the cache, whatever the page asked for. A response the server marks
 *   `no-store` or `private`, that redirected, or that is not a same-origin 200 is refused too.
 * - **Only the shell's paths are cached**, and never one under `/admin`, whose routes answer only a
 *   signed-in admin.
 * - **Navigations are never cached.** A navigation goes to the network; when the network fails, a
 *   navigation to `/offline` is answered from the cache, and any other one is sent there, so an
 *   installed admin with no network opens to its shell and its queue.
 *
 * The shell is fetched when the worker installs, and again whenever an open admin page asks
 * (`refresh-shell`), so a deploy's new assets replace the old ones while there is a network.
 * Logout deletes every cache (`../_offline/sign-out.ts`, [SYNC-9]).
 *
 * **Self-contained by construction.** `./route.ts` serves this function's own source text, so the
 * function may reference nothing outside itself: no import (types excepted), no module constant.
 * `tests/app/service-worker.test.ts` runs the script the route serves, in a context of its own,
 * which fails when it reaches outside.
 */

/** What the worker is told by the script that calls it. */
export interface WorkerConfig {
  /** The cache it keeps the shell in; any other `plinthos-` cache is deleted when it activates. */
  readonly cacheName: string;
  /** The data-free shell document, `/offline`. */
  readonly shellPath: string;
  /** Other public files to keep with the shell: the manifest and its icons. */
  readonly precache: readonly string[];
}

/** The part of a fetch event the worker uses. */
export interface WorkerFetchEvent {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
  waitUntil(promise: Promise<unknown>): void;
}

/** The part of an install, activate or message event the worker uses. */
export interface WorkerLifecycleEvent {
  readonly data?: unknown;
  waitUntil(promise: Promise<unknown>): void;
}

/** The part of `ServiceWorkerGlobalScope` the worker uses, so tests can stand in for it. */
export interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorage;
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: 'fetch', listener: (event: WorkerFetchEvent) => void): void;
  addEventListener(type: 'install' | 'activate' | 'message', listener: (event: WorkerLifecycleEvent) => void): void;
}

export function serviceWorker(scope: WorkerScope, config: WorkerConfig): void {
  const origin = scope.location.origin;
  const shellUrl = new URL(config.shellPath, origin).href;

  /** Whether a same-origin path may ever be cached: the shell, a static build asset, or a listed file. */
  function isShellPath(pathname: string): boolean {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) return false;
    return pathname === config.shellPath || pathname.startsWith('/_next/static/') || config.precache.includes(pathname);
  }

  /** Whether a response the worker fetched itself may be stored. */
  function storable(url: string, response: Response): boolean {
    const target = new URL(url);
    if (target.origin !== origin || !isShellPath(target.pathname)) return false;
    if (response.status !== 200 || response.redirected || (response.type !== 'basic' && response.type !== 'default')) return false;
    const cacheControl = (response.headers.get('cache-control') ?? '').toLowerCase();
    return !/\b(no-store|private)\b/.test(cacheControl);
  }

  /** Fetches one shell file without credentials, or null when it can't be had or kept. */
  async function fetchShellFile(url: string): Promise<Response | null> {
    try {
      const response = await scope.fetch(url, { credentials: 'omit', cache: 'no-cache', redirect: 'error' });
      return storable(url, response) ? response : null;
    } catch {
      return null;
    }
  }

  /** The static build assets a shell document loads, as same-origin URLs. */
  function assetsOf(html: string): string[] {
    const found = new Set<string>();
    for (const match of html.matchAll(/(?:\/_next\/)?static\/(?:chunks|css|media)\/[A-Za-z0-9_\-./~%@[\]]+?\.(?:js|css|woff2?|png|svg|webp|ico)/g)) {
      const path = match[0].startsWith('/_next/') ? match[0] : `/_next/${match[0]}`;
      found.add(new URL(path, origin).href);
    }
    return [...found];
  }

  /**
   * Fetches the shell and everything it loads, then stores them: the assets first and the
   * document last, so a shell is never stored before what it loads. Files the new shell no longer
   * loads are deleted afterwards. A shell that can't be fetched leaves the cache as it was.
   */
  async function precache(): Promise<void> {
    const shell = await fetchShellFile(shellUrl);
    if (shell === null) throw new Error('the shell could not be fetched');
    const html = await shell.clone().text();
    const urls = [...new Set([...config.precache.map((path) => new URL(path, origin).href), ...assetsOf(html)])];
    const files = await Promise.all(urls.map(async (url) => [url, await fetchShellFile(url)] as const));
    const cache = await scope.caches.open(config.cacheName);
    const kept = new Set([shellUrl]);
    for (const [url, response] of files) {
      if (response === null) continue;
      await cache.put(url, response);
      kept.add(url);
    }
    await cache.put(shellUrl, shell);
    for (const key of await cache.keys()) {
      if (!kept.has(key.url)) await cache.delete(key);
    }
  }

  async function cached(url: string): Promise<Response | undefined> {
    const cache = await scope.caches.open(config.cacheName);
    return cache.match(url);
  }

  scope.addEventListener('install', (event) => {
    event.waitUntil(precache().then(() => scope.skipWaiting()));
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await scope.caches.keys()) {
          if (name.startsWith('plinthos-') && name !== config.cacheName) await scope.caches.delete(name);
        }
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('message', (event) => {
    const type = (event.data as { type?: unknown } | null | undefined)?.type;
    if (type === 'refresh-shell') event.waitUntil(precache().catch(() => undefined));
  });

  scope.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== origin) return;

    if (request.mode === 'navigate') {
      // The page itself always comes from the network, and is never stored.
      event.respondWith(
        scope.fetch(request).catch(async () => {
          if (url.href === shellUrl) return (await cached(shellUrl)) ?? Response.error();
          return Response.redirect(shellUrl, 302);
        }),
      );
      return;
    }

    if (url.pathname !== config.shellPath && isShellPath(url.pathname)) {
      // A shell file: from the cache when it is there, else from the network, without storing
      // what the page's own request returned.
      event.respondWith(
        (async () => {
          const hit = await cached(url.origin + url.pathname);
          return hit ?? scope.fetch(request);
        })(),
      );
    }
    // Anything else, an admin route above all, goes to the network untouched.
  });
}
