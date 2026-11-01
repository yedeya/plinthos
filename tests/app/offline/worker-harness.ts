/**
 * A stand-in for a service worker's global scope, its Cache Storage and its network, for
 * `tests/app/offline/service-worker.test.ts`. The worker runs from the very script `/sw.js`
 * serves, evaluated in a context of its own, so a worker that reaches outside its own source
 * fails here before it fails in a browser.
 */
import { runInNewContext } from 'node:vm';
import { GET } from '../../../src/app/sw.js/route';

export const ORIGIN = 'https://admin.example.test';

/** What one network request the worker made carried. */
export interface SentRequest {
  readonly url: string;
  readonly credentials: RequestCredentials;
  readonly mode: string;
}

/** A response the cache holds, with the request that fetched it. */
interface Stored {
  readonly response: Response;
  readonly fetchedWith: SentRequest | undefined;
}

/** A request as the browser hands it to the fetch handler. */
export interface PageRequest {
  readonly url: string;
  readonly method?: string;
  readonly mode?: 'navigate' | 'cors' | 'no-cors' | 'same-origin';
  /** A page's own request to its origin carries the session cookie. */
  readonly credentials?: RequestCredentials;
}

type Route = (request: SentRequest) => Response;

/** The responses of a made-up admin: the shell, its assets, the manifest, and an admin page. */
export function adminServer(overrides: Record<string, Route> = {}): Record<string, Route> {
  const asset = (body: string, type: string): Route => () => new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' } });
  return {
    '/offline': () =>
      new Response(
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/css/shell-a1.css"/><script src="/_next/static/chunks/main-b2.js" async=""></script></head>' +
          '<body><script>self.__next_f.push([1,"I:[\\"static/chunks/page-c3.js\\"]"])</script></body></html>',
        { headers: { 'content-type': 'text/html', 'cache-control': 's-maxage=31536000' } },
      ),
    '/_next/static/css/shell-a1.css': asset('body{}', 'text/css'),
    '/_next/static/chunks/main-b2.js': asset('/* main */', 'text/javascript'),
    '/_next/static/chunks/page-c3.js': asset('/* page */', 'text/javascript'),
    '/manifest.webmanifest': asset('{}', 'application/manifest+json'),
    '/icons/icon-192.png': asset('png', 'image/png'),
    '/icons/icon-512.png': asset('png', 'image/png'),
    '/admin': () => new Response('<p>private: storage location</p>', { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } }),
    '/admin/api/sync': () => Response.json({ outcomes: [] }, { headers: { 'cache-control': 'no-store' } }),
    '/login': () => new Response('<form></form>', { headers: { 'content-type': 'text/html' } }),
    ...overrides,
  };
}

class FakeCache {
  readonly entries = new Map<string, Stored>();
  constructor(private readonly lastFetch: Map<Response, SentRequest>) {}
  async put(key: string | Request, response: Response): Promise<void> {
    this.entries.set(typeof key === 'string' ? key : key.url, { response, fetchedWith: this.lastFetch.get(response) });
  }
  async match(key: string | Request): Promise<Response | undefined> {
    return this.entries.get(typeof key === 'string' ? key : key.url)?.response.clone();
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(key: string | { url: string }): Promise<boolean> {
    return this.entries.delete(typeof key === 'string' ? key : key.url);
  }
}

export class WorkerHarness {
  online = true;
  readonly sent: SentRequest[] = [];
  readonly caches = new Map<string, FakeCache>();
  private readonly fetchedBy = new Map<Response, SentRequest>();
  private readonly listeners = new Map<string, (event: unknown) => void>();
  claimed = false;
  skippedWaiting = false;

  constructor(public routes: Record<string, Route> = adminServer()) {}

  /** Loads the script `/sw.js` serves into a fresh context whose `self` is this harness. */
  async load(): Promise<this> {
    const response = GET();
    const script = await response.text();
    const caches = this.caches;
    const fetchedBy = this.fetchedBy;
    const cacheStorage = {
      async open(name: string) {
        let cache = caches.get(name);
        if (cache === undefined) caches.set(name, (cache = new FakeCache(fetchedBy)));
        return cache;
      },
      async keys() {
        return [...caches.keys()];
      },
      async delete(name: string) {
        return caches.delete(name);
      },
      async has(name: string) {
        return caches.has(name);
      },
      async match() {
        return undefined;
      },
    };
    const self = {
      location: { origin: ORIGIN },
      caches: cacheStorage,
      fetch: (input: string | PageRequest, init?: RequestInit) => this.network(input, init),
      skipWaiting: async () => {
        this.skippedWaiting = true;
      },
      clients: {
        claim: async () => {
          this.claimed = true;
        },
      },
      addEventListener: (type: string, listener: (event: unknown) => void) => this.listeners.set(type, listener),
    };
    // Only the language's own globals and the web APIs a worker has: nothing of this module.
    runInNewContext(script, { self, URL, Response, Set, Promise, Error });
    return this;
  }

  private async network(input: string | PageRequest, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url;
    const sent: SentRequest = {
      url,
      credentials: init?.credentials ?? (typeof input === 'string' ? 'same-origin' : (input.credentials ?? 'include')),
      mode: typeof input === 'string' ? 'cors' : (input.mode ?? 'no-cors'),
    };
    this.sent.push(sent);
    if (!this.online) throw new TypeError('Failed to fetch');
    const route = this.routes[new URL(url).pathname];
    const response = route === undefined ? new Response('not found', { status: 404 }) : route(sent);
    this.fetchedBy.set(response, sent);
    return response;
  }

  private async lifecycle(type: 'install' | 'activate' | 'message', data?: unknown): Promise<void> {
    const pending: Promise<unknown>[] = [];
    this.listeners.get(type)?.({ data, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }

  install = () => this.lifecycle('install');
  activate = () => this.lifecycle('activate');
  message = (data: unknown) => this.lifecycle('message', data);

  /** Hands a request to the fetch handler: its response, or undefined when it let the request through. */
  async fetch(request: PageRequest): Promise<Response | undefined> {
    let answer: Promise<Response> | Response | undefined;
    const pending: Promise<unknown>[] = [];
    this.listeners.get('fetch')?.({
      request: { method: 'GET', credentials: 'include', mode: 'no-cors', ...request, url: new URL(request.url, ORIGIN).href },
      respondWith: (response: Promise<Response> | Response) => {
        answer = response;
      },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
    return answer === undefined ? undefined : await answer;
  }

  /** Every cached entry, across every cache: its URL and the request that fetched it. */
  stored(): { url: string; fetchedWith: SentRequest | undefined; response: Response }[] {
    return [...this.caches.values()].flatMap((cache) => [...cache.entries].map(([url, stored]) => ({ url, ...stored })));
  }
}
