/**
 * The Rebrickable client, against a stand-in `fetch` and made-up sets and themes only: no test
 * reaches Rebrickable, and no key here is real. Time is a fake clock that the injected `sleep`
 * advances, so the limiter, the backoff and the budget are checked to the millisecond.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE,
  CatalogueUnavailable,
  clearThemeCache,
  linkedCatalogueProvider,
  MIN_REQUEST_INTERVAL_MS,
  rebrickableProvider,
  REQUEST_TIMEOUT_MS,
  resetRebrickableRateLimit,
  retryAfterMs,
  type CatalogueUnavailableReason,
} from '../../../src/server/catalogue/rebrickable';
import { captureSharedLogger } from '../capture';

/** A made-up key, distinctive enough to find in any line it leaked into. */
const CANARY_KEY = 'canary-rebrickable-key-0f3a9c71d2e84b56';

const SET_A = { set_num: '90001-1', name: 'Made-up Lighthouse', year: 2031, theme_id: 9001, num_parts: 1234, set_img_url: 'https://cdn.example.test/90001-1.jpg' };
const SET_B = { set_num: '90002-1', name: 'Made-up Harbour', year: 2032, theme_id: 9002, num_parts: 567, set_img_url: null };
const THEMES = { 9001: 'Imaginary Icons', 9002: 'Pretend City' } as Record<number, string>;

interface Call {
  url: string;
  at: number;
  headers: Headers;
}

/** A fake clock, and a stand-in fetch whose answers a test scripts per URL. */
function harness(route: (url: string, call: number) => Response | 'hang' | Promise<Response>) {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: clock, headers: new Headers(init?.headers) });
    const answer = route(url, calls.length);
    if (answer === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return answer;
  });
  const provider = rebrickableProvider(CANARY_KEY, {
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { provider, calls, sleeps, advance: (ms: number) => (clock += ms), now: () => clock };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** Answers sets and themes from the fixtures. */
function catalogue(url: string): Response {
  const path = url.slice(API_BASE.length);
  const theme = /^\/lego\/themes\/(\d+)\/$/.exec(path);
  if (theme) {
    const id = Number(theme[1]);
    return THEMES[id] === undefined ? json({ detail: 'Not found.' }, { status: 404 }) : json({ id, parent_id: null, name: THEMES[id] });
  }
  if (path.startsWith('/lego/themes/?')) return json({ count: 2, next: null, previous: null, results: Object.entries(THEMES).map(([id, name]) => ({ id: Number(id), parent_id: null, name })) });
  if (path.startsWith('/lego/sets/?')) return json({ count: 2, next: null, previous: null, results: [SET_A, SET_B] });
  const set = /^\/lego\/sets\/([^/]+)\/$/.exec(path);
  const found = [SET_A, SET_B].find((candidate) => candidate.set_num === decodeURIComponent(set?.[1] ?? ''));
  return found === undefined ? json({ detail: 'Not found.' }, { status: 404 }) : json(found);
}

async function reasonOf(promise: Promise<unknown>): Promise<CatalogueUnavailableReason> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CatalogueUnavailable);
  return (error as CatalogueUnavailable).reason;
}

let captured: ReturnType<typeof captureSharedLogger>;
beforeEach(() => {
  resetRebrickableRateLimit();
  clearThemeCache();
  captured = captureSharedLogger();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the Rebrickable client', () => {
  it('[CAT-2] looks a set up by its number, with its theme’s name, sending the key in the Authorization header only', async () => {
    const { provider, calls } = harness(catalogue);
    await expect(provider.getSet('90001-1', { budgetMs: 10_000 })).resolves.toEqual({
      setNum: '90001-1',
      name: 'Made-up Lighthouse',
      theme: 'Imaginary Icons',
      year: 2031,
      numParts: 1234,
      imageUrl: 'https://cdn.example.test/90001-1.jpg',
    });
    expect(calls.map(({ url }) => url)).toEqual([`${API_BASE}/lego/sets/90001-1/`, `${API_BASE}/lego/themes/9001/`]);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(`key ${CANARY_KEY}`);
      expect(call.url).not.toContain(CANARY_KEY);
    }
  });

  it('[CAT-2] answers null for a set Rebrickable does not know, a 404, and logs no failure', async () => {
    const { provider } = harness(catalogue);
    await expect(provider.getSet('99999-9', { budgetMs: 10_000 })).resolves.toBeNull();
    expect(captured.events().filter((event) => event.businessEvent === 'catalogue.lookup.failed')).toEqual([]);
  });

  it('[CAT-2] searches with a page size of 10, and resolves the themes of several sets in one request', async () => {
    const { provider, calls } = harness(catalogue);
    const sets = await provider.searchSets('made up', { budgetMs: 10_000 });
    expect(sets.map(({ setNum, theme, imageUrl }) => ({ setNum, theme, imageUrl }))).toEqual([
      { setNum: '90001-1', theme: 'Imaginary Icons', imageUrl: 'https://cdn.example.test/90001-1.jpg' },
      { setNum: '90002-1', theme: 'Pretend City', imageUrl: null },
    ]);
    const search = new URL(calls[0]?.url ?? '');
    expect(search.pathname).toBe('/api/v3/lego/sets/');
    expect(search.searchParams.get('search')).toBe('made up');
    expect(search.searchParams.get('page_size')).toBe('10');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toMatch(/\/lego\/themes\/\?page_size=/);
  });

  it('[CAT-2] caches theme names in memory: a second lookup in a known theme asks for the set only', async () => {
    const { provider, calls } = harness(catalogue);
    await provider.getSet('90001-1', { budgetMs: 10_000 });
    await provider.getSet('90001-1', { budgetMs: 10_000 });
    await provider.searchSets('made', { budgetMs: 10_000 });
    const themeCalls = calls.filter(({ url }) => url.includes('/lego/themes/'));
    // One for 9001; the search then needs only 9002, by its id.
    expect(themeCalls.map(({ url }) => url)).toEqual([`${API_BASE}/lego/themes/9001/`, `${API_BASE}/lego/themes/9002/`]);
  });

  it('[CAT-2] starts at most one request a second, across every provider in the instance', async () => {
    const first = harness(catalogue);
    await first.provider.getSet('90001-1', { budgetMs: 10_000 });
    await first.provider.getSet('90002-1', { budgetMs: 10_000 });
    const starts = first.calls.map(({ at }) => at);
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i += 1) expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS);

    // Concurrent calls queue on the same limiter rather than each starting at once.
    resetRebrickableRateLimit();
    clearThemeCache();
    // The fake clock jumps the moment one call sleeps, so a request's start is read from the time
    // the queue has spent: four requests need three full gaps between them.
    const second = harness(catalogue);
    const started = second.now();
    await Promise.all([second.provider.getSet('90001-1', { budgetMs: 20_000 }), second.provider.getSet('90002-1', { budgetMs: 20_000 })]);
    expect(second.calls).toHaveLength(4);
    expect(second.sleeps).toEqual([MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS]);
    expect(second.now() - started).toBeGreaterThanOrEqual(3 * MIN_REQUEST_INTERVAL_MS);
  });

  it('[CAT-2] fails as a timeout, without a request, when the next free slot would come after the budget', async () => {
    const { provider, calls } = harness(catalogue);
    await provider.getSet('90001-1', { budgetMs: 10_000 });
    const before = calls.length;
    expect(await reasonOf(provider.getSet('90002-1', { budgetMs: 500 }))).toBe('timeout');
    expect(calls).toHaveLength(before);
  });

  it('[CAT-2] aborts a request after at most 5 seconds and fails as a timeout', async () => {
    vi.useFakeTimers();
    const { provider, calls } = harness(() => 'hang');
    const pending = provider.getSet('90001-1', { budgetMs: 60_000 });
    const outcome = reasonOf(pending);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('timeout');
    // A timeout is not retried: it has already spent up to 5 seconds of the budget.
    expect(calls).toHaveLength(1);
  });

  it('[CAT-2] times a request out at the end of a budget shorter than 5 seconds', async () => {
    vi.useFakeTimers();
    const { provider } = harness(() => 'hang');
    const outcome = reasonOf(provider.searchSets('made', { budgetMs: 1500 }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await outcome).toBe('timeout');
  });

  it('[CAT-2] retries a 429 or a 5xx at most twice, with exponential backoff, then fails with the reason', async () => {
    const limited = harness(() => json({ detail: 'Request was throttled.' }, { status: 429 }));
    expect(await reasonOf(limited.provider.getSet('90001-1', { budgetMs: 60_000 }))).toBe('rate-limited');
    expect(limited.calls).toHaveLength(3);
    expect(limited.sleeps.filter((ms) => ms > MIN_REQUEST_INTERVAL_MS - 1)).toEqual([1000, 2000]);

    resetRebrickableRateLimit();
    const down = harness(() => new Response('bad gateway', { status: 502 }));
    expect(await reasonOf(down.provider.searchSets('made', { budgetMs: 60_000 }))).toBe('upstream');
    expect(down.calls).toHaveLength(3);

    resetRebrickableRateLimit();
    const recovers = harness((url, call) => (call === 1 ? new Response('', { status: 503 }) : catalogue(url)));
    await expect(recovers.provider.getSet('90001-1', { budgetMs: 60_000 })).resolves.toMatchObject({ setNum: '90001-1' });
  });

  it('[CAT-2] does not retry a 400', async () => {
    const { provider, calls } = harness(() => json({ detail: 'bad' }, { status: 400 }));
    expect(await reasonOf(provider.getSet('90001-1', { budgetMs: 60_000 }))).toBe('upstream');
    expect(calls).toHaveLength(1);
  });

  it('[CAT-2] waits at least what Retry-After asks, in seconds or as a date', async () => {
    const { provider, calls } = harness((url, call) => (call === 1 ? json({}, { status: 429, headers: { 'Retry-After': '7' } }) : catalogue(url)));
    await provider.getSet('90001-1', { budgetMs: 60_000 });
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(7000);

    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });

  it('[CAT-2] never retries past the budget: a Retry-After beyond it fails at once, without waiting', async () => {
    const { provider, calls, sleeps } = harness(() => json({}, { status: 429, headers: { 'Retry-After': '30' } }));
    expect(await reasonOf(provider.getSet('90001-1', { budgetMs: 5000 }))).toBe('rate-limited');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);

    resetRebrickableRateLimit();
    // Backoff of 1 s, then 2 s: the second retry would end past a 2.5-second budget.
    const short = harness(() => new Response('', { status: 500 }));
    const started = short.now();
    expect(await reasonOf(short.provider.getSet('90001-1', { budgetMs: 2500 }))).toBe('upstream');
    expect(short.calls).toHaveLength(2);
    expect(short.now() - started).toBeLessThan(2500);
  });

  it('[CAT-2] [CAT-4] a 401 or a 403 fails as refused-key, without a retry', async () => {
    for (const status of [401, 403]) {
      resetRebrickableRateLimit();
      const { provider, calls } = harness(() => json({ detail: 'Invalid token.' }, { status }));
      expect(await reasonOf(provider.searchSets('made', { budgetMs: 60_000 })), String(status)).toBe('refused-key');
      expect(calls).toHaveLength(1);
    }
  });

  it('[CAT-2] an answer it can not read, or a network failure, is upstream', async () => {
    const odd = harness(() => json({ unexpected: true }));
    expect(await reasonOf(odd.provider.getSet('90001-1', { budgetMs: 60_000 }))).toBe('upstream');
    resetRebrickableRateLimit();
    const offline = harness(() => Promise.reject(new TypeError(`fetch failed for ${API_BASE}/lego/sets/`)));
    expect(await reasonOf(offline.provider.getSet('90001-1', { budgetMs: 60_000 }))).toBe('upstream');
  });

  it('[CAT-2] [CAT-4] logs catalogue.lookup.failed with the reason, and never the key or a URL', async () => {
    const reasons: CatalogueUnavailableReason[] = [];
    const scripts: (() => Response | 'hang' | Promise<Response>)[] = [
      () => json({}, { status: 401 }),
      () => json({}, { status: 429 }),
      () => new Response(`upstream echoed key ${CANARY_KEY}`, { status: 500 }),
      () => Promise.reject(new TypeError(`${API_BASE}/lego/sets/?key=${CANARY_KEY}`)),
    ];
    for (const script of scripts) {
      resetRebrickableRateLimit();
      const { provider } = harness(script);
      reasons.push(await reasonOf(provider.getSet('90001-1', { budgetMs: 60_000 })));
    }
    const failures = captured.events().filter((event) => event.businessEvent === 'catalogue.lookup.failed');
    expect(failures.map((event) => event.reason)).toEqual(reasons);
    expect(reasons).toEqual(['refused-key', 'rate-limited', 'upstream', 'upstream']);
    for (const event of failures) expect(event).toMatchObject({ level: 'warn', operation: 'getSet' });
    const output = captured.lines.join('');
    expect(output).not.toContain(CANARY_KEY);
    expect(output).not.toContain('rebrickable.com');
    expect(output).not.toMatch(/https?:\/\//);
  });
});

describe('the Rebrickable key', () => {
  it('[CAT-4] is never in the message of the error a caller receives', async () => {
    const { provider } = harness(() => json({}, { status: 403 }));
    const error = await provider.getSet('90001-1', { budgetMs: 60_000 }).catch((thrown: unknown) => thrown as Error);
    expect(String((error as Error).message)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(error)).not.toContain(CANARY_KEY);
  });

  it('[CAT-4] is read from the server function’s link only: with none linked, every call is refused-key and nothing is fetched', async () => {
    const fetchImpl = vi.fn();
    const provider = linkedCatalogueProvider({ fetch: fetchImpl as unknown as typeof fetch });
    expect(await reasonOf(provider.searchSets('made', { budgetMs: 1000 }))).toBe('refused-key');
    expect(await reasonOf(provider.getSet('90001-1', { budgetMs: 1000 }))).toBe('refused-key');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(captured.events().filter((event) => event.businessEvent === 'catalogue.lookup.failed').map((event) => event.reason)).toEqual(['refused-key', 'refused-key']);
  });
});
