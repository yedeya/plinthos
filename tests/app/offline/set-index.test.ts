// @vitest-environment happy-dom
import { gzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSetIndex,
  checkSetIndexOnce,
  deleteSetIndex,
  holdsNumber,
  isStale,
  loadSearchIndex,
  readIndexMeta,
  searchIndex,
  SET_INDEX_CHECKED_KEY,
  SET_INDEX_ENDPOINT,
  STALE_AFTER_MS,
  toSearchable,
  type IndexEntry,
} from '../../../src/app/_offline/set-index';
import { rankSets } from '../../../src/server/catalogue/rank';
import { SET_IMAGE_BASE, type MinifigRow, type SetRow, type ThemeRow } from '../../../src/server/catalogue/set-index/rows';

/**
 * `[CAT-10]` and `[CAT-11]`: the device's copy of the set index, in an IndexedDB database of its
 * own, checked against the admin's route with the version it holds and replaced only once a new
 * one is fully read and parsed; and the search over it, by `rankSets`'s rules. Every set,
 * minifigure, theme and version is made up.
 */

const VERSION_A = 'a'.repeat(64);
const VERSION_B = 'b'.repeat(64);

const THEMES: ThemeRow[] = [
  [1, 'Made-up Space', null],
  [2, 'Made-up Castle', null],
  [3, 'Made-up Space Sub', 1],
];

const SETS: SetRow[] = [
  ['99901-1', 'Made-up Rocket', 1, 2001, 120],
  ['99901-2', 'Made-up Rocket, second edition', 1, 2002, 130, '99901-2b.jpg'],
  ['999010-1', 'Made-up Rocket base', 3, 2003, 300, ''],
  ['99902-1', 'Made-up Keep', 2, 2004, 400, 'https://images.example.invalid/made-up-keep.png'],
  ['99903-1', 'Made-up Rocket launcher', 3, 2005, 50],
  ['99904-1', 'Made-up Drawbridge', 2, 2006, 60, 'javascript:alert(1)'],
];

const MINIFIGS: MinifigRow[] = [
  ['fig-990001', 'Made-up Rocket pilot', 4],
  ['fig-990002', 'Made-up Knight', 5],
];

function index(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    builtAt: '2026-10-26T08:00:00.000Z',
    sources: { sets: 'Mon, 26 Oct 2026 05:00:00 GMT', themes: null, minifigs: null },
    themes: THEMES,
    sets: SETS,
    minifigs: MINIFIGS,
    ...overrides,
  };
}

function gzipped(value: unknown): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value), 'utf8')));
}

function indexResponse(version: string, body: Uint8Array = gzipped(index())): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { etag: `"${version}"`, 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
}

let factory: IDBFactory;
let sent: { url: string; init: RequestInit }[];

function fetchAnswering(answer: (init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer(init);
  }) as unknown as typeof fetch;
}

function ifNoneMatch(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('if-none-match');
}

beforeEach(() => {
  factory = new IDBFactory();
  sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the set index on the device', () => {
  it('[CAT-10] downloads the index when the device holds none, and then asks with its version and keeps it on a 304', async () => {
    expect(await readIndexMeta(factory)).toBeNull();
    expect(await checkSetIndex({ factory, fetch: fetchAnswering(() => indexResponse(VERSION_A)) })).toBe('updated');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(SET_INDEX_ENDPOINT);
    expect(ifNoneMatch(sent[0]?.init)).toBeNull();
    expect(sent[0]?.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(await readIndexMeta(factory)).toEqual({ version: VERSION_A, builtAt: '2026-10-26T08:00:00.000Z', counts: { sets: SETS.length, minifigs: MINIFIGS.length, themes: THEMES.length } });

    expect(await checkSetIndex({ factory, fetch: fetchAnswering(() => new Response(null, { status: 304, headers: { etag: `"${VERSION_A}"` } })) })).toBe('unchanged');
    expect(ifNoneMatch(sent[1]?.init)).toBe(`"${VERSION_A}"`);
    expect((await readIndexMeta(factory))?.version).toBe(VERSION_A);
    expect((await loadSearchIndex(factory))?.entries).toHaveLength(SETS.length + MINIFIGS.length);
  });

  it('[CAT-10] replaces the stored index when the version changed, and only once the new one is read and parsed', async () => {
    await checkSetIndex({ factory, fetch: fetchAnswering(() => indexResponse(VERSION_A)) });
    const newer = index({ builtAt: '2026-11-02T08:00:00.000Z', sets: [...SETS, ['99905-1', 'Made-up Newer set', 1, 2026, 10]] });
    expect(await checkSetIndex({ factory, fetch: fetchAnswering(() => indexResponse(VERSION_B, gzipped(newer))) })).toBe('updated');
    expect(ifNoneMatch(sent[1]?.init)).toBe(`"${VERSION_A}"`);
    expect(await readIndexMeta(factory)).toMatchObject({ version: VERSION_B, builtAt: '2026-11-02T08:00:00.000Z' });
    const loaded = await loadSearchIndex(factory);
    if (loaded === null) throw new Error('no index loaded');
    expect(loaded.version).toBe(VERSION_B);
    expect(searchIndex(loaded, 'Newer').map((entry) => entry.setNum)).toEqual(['99905-1']);
  });

  it('[CAT-10] keeps the old index when a download fails: truncated, not gzip, the wrong shape, an error, a login page, no version or no network', async () => {
    await checkSetIndex({ factory, fetch: fetchAnswering(() => indexResponse(VERSION_A)) });
    const whole = gzipped(index({ builtAt: '2026-11-02T08:00:00.000Z' }));
    const failures: (() => Response | Promise<Response>)[] = [
      () => indexResponse(VERSION_B, whole.subarray(0, Math.floor(whole.byteLength / 2))),
      () => indexResponse(VERSION_B, new TextEncoder().encode('{"format":1}')),
      () => indexResponse(VERSION_B, gzipped(index({ format: 2 }))),
      () => indexResponse(VERSION_B, gzipped(index({ sets: [['99901-1', 'Made-up Rocket', 'not a theme id', 2001, 120]] }))),
      () => indexResponse(VERSION_B, gzipped(index({ builtAt: 'yesterday' }))),
      () => indexResponse(VERSION_B, new TextEncoder().encode('not json at all')),
      () => new Response('made-up server error', { status: 500 }),
      () => new Response('<html>Made-up sign-in page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response(new Uint8Array(whole), { status: 200, headers: { 'content-type': 'application/gzip' } }),
      () => Promise.reject(new TypeError('made-up network failure')),
    ];
    for (const failure of failures) {
      expect(await checkSetIndex({ factory, fetch: fetchAnswering(failure) })).toBe('failed');
      expect(await readIndexMeta(factory)).toMatchObject({ version: VERSION_A, builtAt: '2026-10-26T08:00:00.000Z' });
    }
    expect((await loadSearchIndex(factory))?.entries).toHaveLength(SETS.length + MINIFIGS.length);
  });

  it('[CAT-10] keeps what the device holds while the server has built no index', async () => {
    expect(await checkSetIndex({ factory, fetch: fetchAnswering(() => new Response('No set index has been built yet.', { status: 404 })) })).toBe('missing');
    expect(await readIndexMeta(factory)).toBeNull();
    await checkSetIndex({ factory, fetch: fetchAnswering(() => indexResponse(VERSION_A)) });
    expect(await checkSetIndex({ factory, fetch: fetchAnswering(() => new Response('No set index has been built yet.', { status: 404 })) })).toBe('missing');
    expect((await readIndexMeta(factory))?.version).toBe(VERSION_A);
  });

  it('[CAT-10] asks the route once when the admin opens online, again only after a check that failed, and never offline', async () => {
    vi.stubGlobal('indexedDB', factory);
    window.sessionStorage.removeItem(SET_INDEX_CHECKED_KEY);
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    let answer: () => Response | Promise<Response> = () => indexResponse(VERSION_A);
    vi.stubGlobal('fetch', fetchAnswering(() => answer()));

    expect(await checkSetIndexOnce()).toBe('skipped');
    expect(sent).toEqual([]);

    online = true;
    answer = () => Promise.reject(new TypeError('made-up network failure'));
    expect(await checkSetIndexOnce()).toBe('failed');
    answer = () => indexResponse(VERSION_A);
    const [first, second] = await Promise.all([checkSetIndexOnce(), checkSetIndexOnce()]);
    expect([first, second]).toEqual(['updated', 'updated']);
    expect(sent).toHaveLength(2);
    expect(await checkSetIndexOnce()).toBe('skipped');
    expect(sent).toHaveLength(2);
    window.sessionStorage.removeItem(SET_INDEX_CHECKED_KEY);
  });

  it('[CAT-10] logout’s deletion takes the whole database off the device', async () => {
    await checkSetIndex({ factory, fetch: fetchAnswering(() => indexResponse(VERSION_A)) });
    await loadSearchIndex(factory);
    await deleteSetIndex(factory);
    expect((await factory.databases()).map((database) => database.name)).not.toContain('plinthos-set-index');
    expect(await readIndexMeta(factory)).toBeNull();
    expect(await loadSearchIndex(factory)).toBeNull();
  });

  it('[CAT-10] says the index is stale once it is older than 14 days', () => {
    const builtAt = '2026-10-20T08:00:00.000Z';
    const built = Date.parse(builtAt);
    expect(isStale(builtAt, new Date(built + STALE_AFTER_MS))).toBe(false);
    expect(isStale(builtAt, new Date(built + STALE_AFTER_MS + 1))).toBe(true);
    expect(STALE_AFTER_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe('the search over the set index', () => {
  const searchable = toSearchable(VERSION_A, index());

  it('[CAT-11] finds sets and minifigures together, from 2 characters, ranked by the rules of rankSets, at most 10', () => {
    expect(searchIndex(searchable, 'R')).toEqual([]);
    expect(searchIndex(searchable, ' ')).toEqual([]);

    const rocket = searchIndex(searchable, 'rocket');
    expect(rocket.map((entry) => entry.setNum)).toEqual(['99901-1', '99901-2', '999010-1', '99903-1', 'fig-990001']);
    expect(rocket.find((entry) => entry.setNum === 'fig-990001')?.kind).toBe('minifig');

    // The same order rankSets gives the matching entries, sets first in the index's own order.
    for (const query of ['99901', '99901-2', '9990', 'made-up', 'fig-99', 'Knight', 'ROCKET']) {
      const matches = searchable.entries.filter((entry) => entry.setNum.toLowerCase().startsWith(query.toLowerCase()) || entry.setNum.toLowerCase().replace(/-\d+$/, '') === query.toLowerCase().replace(/-\d+$/, '') || entry.name.toLowerCase().includes(query.toLowerCase()));
      expect(searchIndex(searchable, query), query).toEqual(rankSets(query, matches).slice(0, 10));
    }
    expect(searchIndex(searchable, '99901').map((entry) => entry.setNum)).toEqual(['99901-1', '99901-2', '999010-1']);

    const many = toSearchable(VERSION_A, index({ sets: Array.from({ length: 30 }, (_, n): SetRow => [`9980${String(n).padStart(2, '0')}-1`, `Made-up Tower ${n}`, 2, 2010, n]) }));
    expect(searchIndex(many, 'tower')).toHaveLength(10);
  });

  it('[CAT-11] answers each result with its number, name, theme and year, and the stock image only from Rebrickable’s address or an https one', () => {
    const byNum = (setNum: string): IndexEntry | undefined => searchable.entries.find((entry) => entry.setNum === setNum);
    expect(byNum('99901-1')).toEqual({ kind: 'set', setNum: '99901-1', name: 'Made-up Rocket', theme: 'Made-up Space', year: 2001, numParts: 120, imageUrl: `${SET_IMAGE_BASE}99901-1.jpg` });
    expect(byNum('99901-2')?.imageUrl).toBe(`${SET_IMAGE_BASE}99901-2b.jpg`);
    expect(byNum('999010-1')).toMatchObject({ theme: 'Made-up Space Sub', imageUrl: null });
    expect(byNum('99902-1')?.imageUrl).toBe('https://images.example.invalid/made-up-keep.png');
    expect(byNum('99904-1')?.imageUrl).toBeNull();
    expect(byNum('fig-990002')).toEqual({ kind: 'minifig', setNum: 'fig-990002', name: 'Made-up Knight', theme: null, year: null, numParts: 5, imageUrl: `${SET_IMAGE_BASE}fig-990002.jpg` });
  });

  it('[CAT-11] knows whether it holds a typed number, with or without its variant', () => {
    expect(holdsNumber(searchable, '99901')).toBe(true);
    expect(holdsNumber(searchable, '99901-2')).toBe(true);
    expect(holdsNumber(searchable, 'FIG-990001')).toBe(true);
    expect(holdsNumber(searchable, '99905')).toBe(false);
    expect(holdsNumber(searchable, '99901-3')).toBe(false);
  });

  it('[CAT-11] searches an index the size of Rebrickable’s quickly enough to run on every keystroke', () => {
    const big = toSearchable(VERSION_A, {
      ...index(),
      sets: Array.from({ length: 29_000 }, (_, n): SetRow => [`${10000 + n}-1`, `Made-up set number ${n}`, 1 + (n % 3), 1990 + (n % 36), n % 5000]),
      minifigs: Array.from({ length: 17_500 }, (_, n): MinifigRow => [`fig-${String(n).padStart(6, '0')}`, `Made-up figure ${n}`, 4]),
    });
    const started = performance.now();
    for (const query of ['12', '123', '1234', '12345', 'made', 'figure 9', 'set number 2']) searchIndex(big, query);
    // Seven searches; a generous bound for a slow CI runner, not the phone's figure.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
