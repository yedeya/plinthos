/**
 * The set index's builder (brief #252, Issue A, [CAT-6] to [CAT-8]), against made-up archive files,
 * a scripted `fetch` and an in-memory store: no test reaches Rebrickable or S3.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_INTERVAL_MS,
  BASE_BACKOFF_MS,
  buildSetIndex,
  DOWNLOAD_BASE,
  DOWNLOAD_TIMEOUT_MS,
  MAX_COMPRESSED_BYTES,
  MAX_DECOMPRESSED_BYTES,
  MAX_RETRIES,
  SOURCES,
  type BuildOutcome,
} from '../../../../src/server/catalogue/set-index/build';
import { ATTEMPT_KEY, CURRENT_KEY, SET_INDEX_PREFIX, versionKey, type SetIndex } from '../../../../src/server/catalogue/set-index/format';
import { repoRoot } from '../../../support/repo-file';
import { archive, CANARY_COLUMN, CANARY_VALUE, clock, LAST_MODIFIED, memoryStore, MINIFIGS_CSV, rebrickable, SETS_CSV, THEMES_CSV, type Script } from './fakes';

afterEach(() => {
  vi.useRealTimers();
});

const ARCHIVE_URLS = SOURCES.map((name) => `${DOWNLOAD_BASE}${name}.csv.gz`);

function build(options: { store?: ReturnType<typeof memoryStore>; files?: Parameters<typeof rebrickable>[0]; script?: Script; time?: ReturnType<typeof clock> } = {}) {
  const store = options.store ?? memoryStore();
  const source = rebrickable(options.files, options.script);
  const time = options.time ?? clock();
  const run = () => buildSetIndex({ store: store.store, fetch: source.fetch, now: time.now, sleep: time.sleep });
  return { store, source, time, run };
}

function current(store: ReturnType<typeof memoryStore>): { version: string; key: string } {
  return JSON.parse(store.text(CURRENT_KEY) ?? 'null') as { version: string; key: string };
}

function readIndex(store: ReturnType<typeof memoryStore>): SetIndex {
  const body = store.objects.get(current(store).key);
  if (body === undefined) throw new Error('no index');
  return JSON.parse(gunzipSync(body).toString('utf8')) as SetIndex;
}

/** The sets file with `count` made-up rows. */
function setsWith(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => `${91000 + index}-1,Made-up Set ${index},2031,9101,${index},https://cdn.rebrickable.com/media/sets/${91000 + index}-1.jpg`);
  return ['set_num,name,year,theme_id,num_parts,img_url', ...rows].join('\n');
}

function minifigsWith(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => `fig-${String(910000 + index)},Made-up Figure ${index},4,`);
  return ['fig_num,name,num_parts,img_url', ...rows].join('\n');
}

/** Every module a module imports, transitively, within the repository's own source. */
function localImports(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), match[1] ?? '');
      const candidates = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')];
      const found = candidates.find((candidate) => {
        try {
          readFileSync(candidate);
          return true;
        } catch {
          return false;
        }
      });
      if (found === undefined) throw new Error(`${relative(repoRoot, file)} imports ${match[1] ?? ''}, which this walk can't find`);
      visit(found);
    }
  };
  visit(join(repoRoot, entry));
  return [...seen].map((file) => relative(repoRoot, file));
}

describe('buildSetIndex: what the index holds', () => {
  it('[CAT-6] holds each set’s number, name, theme, year, parts and an image path only where it differs, each figure’s number, name and parts, the theme tree, the build time and each file’s Last-Modified', async () => {
    const { store, run, time } = build();
    const outcome = await run();
    expect(outcome).toMatchObject({ status: 'built', written: true, counts: { sets: 4, minifigs: 2, themes: 3 } });
    const index = readIndex(store);
    expect(Object.keys(index).sort()).toEqual(['builtAt', 'format', 'minifigs', 'sets', 'sources', 'themes']);
    expect(index.format).toBe(1);
    expect(index.builtAt).toBe(new Date(time.now()).toISOString());
    expect(index.sources).toEqual(LAST_MODIFIED);
    expect(index.sets).toEqual([
      ['90001-1', 'Made-up Lighthouse', 9101, 2031, 1234],
      ['90002-1', 'Sticker Sheet for Sets 90001-1, 90003-2', 9102, 2032, 1, '90002-1/90210.jpg'],
      ['90003-2', 'The "Pretend" Harbour', 9102, 2033, 567, ''],
      ['90004-1', 'Made-up Windmill', 9101, 2034, 890, 'https://images.example.test/90004-1.png'],
    ]);
    expect(index.minifigs).toEqual([
      ['fig-900001', 'Made-up Lighthouse Keeper', 4],
      ['fig-900002', 'Pretend Sailor, with Cap', 5],
    ]);
    expect(index.themes).toEqual([
      [9101, 'Imaginary Icons', null],
      [9102, 'Pretend City', 9101],
      [9103, 'Harbours, Docks', 9102],
    ]);
    // A column no field comes from is left out, wherever it is.
    const text = gunzipSync(store.objects.get(current(store).key) ?? new Uint8Array()).toString('utf8');
    expect(text).not.toContain(CANARY_VALUE);
    expect(text).not.toContain(CANARY_COLUMN);
    expect(text).not.toContain('img_url');
  });

  it('[CAT-6] imports nothing from src/db/, and neither does the builder’s handler', () => {
    for (const entry of ['src/server/catalogue/set-index/build.ts', 'src/server/catalogue/set-index/worker.ts']) {
      const modules = localImports(entry);
      expect(modules.length, entry).toBeGreaterThan(1);
      for (const module of modules) {
        expect(module, `${entry} reaches ${module}`).not.toMatch(/^src\/db\//);
        // The database's own clients sit outside src/db/.
        expect(module, `${entry} reaches ${module}`).not.toMatch(/^src\/server\/(?:database|transaction)\.ts$/);
      }
    }
  });
});

describe('buildSetIndex: the downloads', () => {
  it('[CAT-8] fetches the three archive files and nothing else, whatever the run', async () => {
    const { source, run } = build();
    await run();
    expect([...source.calls].sort()).toEqual([...ARCHIVE_URLS].sort());
    for (const url of source.calls) expect(url).toMatch(/^https:\/\/cdn\.rebrickable\.com\/media\/downloads\/(?:sets|themes|minifigs)\.csv\.gz$/);
  });

  it('[CAT-7] retries a network failure, a 429 and a 5xx at most twice each, with exponential backoff', async () => {
    const { source, run, time } = build({
      script: {
        sets: (attempt) => (attempt === 1 ? 'throw' : attempt === 2 ? new Response('busy', { status: 503 }) : archive(SETS_CSV, 'sets')),
        themes: (attempt) => (attempt === 1 ? new Response('slow down', { status: 429 }) : archive(THEMES_CSV, 'themes')),
      },
    });
    expect(await run()).toMatchObject({ status: 'built' });
    expect(source.calls.filter((url) => url.endsWith('/sets.csv.gz'))).toHaveLength(3);
    expect(source.calls.filter((url) => url.endsWith('/themes.csv.gz'))).toHaveLength(2);
    expect(time.sleeps).toEqual([BASE_BACKOFF_MS, BASE_BACKOFF_MS * 2, BASE_BACKOFF_MS]);
    expect(MAX_RETRIES).toBe(2);
  });

  it('[CAT-7] gives up after two retries, and a 404 is not retried', async () => {
    const down = build({ script: { minifigs: () => new Response('busy', { status: 502 }) } });
    expect(await down.run()).toEqual({ status: 'failed', stage: 'download', reason: 'upstream', file: 'minifigs' });
    expect(down.source.calls.filter((url) => url.endsWith('/minifigs.csv.gz'))).toHaveLength(1 + MAX_RETRIES);
    const gone = build({ script: { themes: () => new Response('gone', { status: 404 }) } });
    expect(await gone.run()).toEqual({ status: 'failed', stage: 'download', reason: 'http-404', file: 'themes' });
    expect(gone.source.calls.filter((url) => url.endsWith('/themes.csv.gz'))).toHaveLength(1);
  });

  it('[CAT-7] aborts a download after at most 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { run, source } = build({ script: { sets: () => 'hang' } });
    const outcome = run();
    for (let step = 0; step <= MAX_RETRIES; step += 1) await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    expect(await outcome).toEqual({ status: 'failed', stage: 'download', reason: 'timeout', file: 'sets' });
    expect(DOWNLOAD_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(source.calls.filter((url) => url.endsWith('/sets.csv.gz'))).toHaveLength(1 + MAX_RETRIES);
  });

  it('[CAT-7] refuses a file past the compressed cap, by its length or by what arrives', async () => {
    const declared = build({ script: { sets: () => archive(SETS_CSV, 'sets', { 'content-length': String(MAX_COMPRESSED_BYTES + 1) }) } });
    expect(await declared.run()).toEqual({ status: 'failed', stage: 'download', reason: 'too-large', file: 'sets' });
    // No length, and more bytes than the cap: refused while it streams.
    const big = new Uint8Array(MAX_COMPRESSED_BYTES + 1);
    const streamed = build({ script: { sets: () => new Response(new Blob([big]).stream(), { status: 200 }) } });
    expect(await streamed.run()).toEqual({ status: 'failed', stage: 'download', reason: 'too-large', file: 'sets' });
  });

  it('[CAT-7] refuses a file past the decompressed cap', async () => {
    // A small archive that inflates past the cap: a run of one byte compresses to almost nothing.
    const bomb = gzipSync(Buffer.alloc(MAX_DECOMPRESSED_BYTES + 1, 0x61));
    expect(bomb.byteLength).toBeLessThan(MAX_COMPRESSED_BYTES);
    const { run, store } = build({ script: { themes: () => new Response(bomb, { status: 200 }) } });
    expect(await run()).toEqual({ status: 'failed', stage: 'download', reason: 'too-large', file: 'themes' });
    expect(store.objects.has(CURRENT_KEY)).toBe(false);
  });

  it('[CAT-7] refuses a file that is not gzip', async () => {
    const { run } = build({ script: { sets: () => new Response(SETS_CSV, { status: 200 }) } });
    expect(await run()).toEqual({ status: 'failed', stage: 'parse', reason: 'not-gzip', file: 'sets' });
  });
});

describe('buildSetIndex: rows and checks', () => {
  it('[CAT-7] skips and counts a row that doesn’t parse', async () => {
    // Too few fields, a year that is no number, and no set number.
    const sets = [SETS_CSV, '90005-1,Too Few Fields,2035', 'bad-1,Made-up Year,twenty,9101,1,,x', ',No Number,2035,9101,1,,x'].join('\n');
    const minifigs = [MINIFIGS_CSV, 'fig-900003,Made-up Parts,many,,x'].join('\n');
    const themes = [THEMES_CSV, 'x,Made-up Id,'].join('\n');
    const { run, store } = build({ files: { sets, minifigs, themes } });
    expect(await run()).toMatchObject({ status: 'built', counts: { sets: 4, minifigs: 2, themes: 3 }, skippedRows: { sets: 3, minifigs: 1, themes: 1 } });
    expect(readIndex(store).sets.map(([setNum]) => setNum)).not.toContain('90005-1');
  });

  it('[CAT-7] fails the parse when a file lacks a column the index needs', async () => {
    const { run, store } = build({ files: { themes: 'id,name\n9101,Imaginary Icons\n' } });
    expect(await run()).toEqual({ status: 'failed', stage: 'parse', reason: 'missing-column', file: 'themes' });
    expect(store.writes.map(({ key }) => key)).toEqual([ATTEMPT_KEY]);
  });

  it('[CAT-7] refuses a build whose sets or minifigures number fewer than 90% of the previous index’s, and keeps the previous index', async () => {
    const store = memoryStore();
    const time = clock();
    const first = build({ store, time, files: { sets: setsWith(100), minifigs: minifigsWith(100) } });
    expect(await first.run()).toMatchObject({ status: 'built', counts: { sets: 100, minifigs: 100 } });
    const before = current(store);

    for (const files of [{ sets: setsWith(89), minifigs: minifigsWith(100) }, { sets: setsWith(100), minifigs: minifigsWith(89) }]) {
      time.advance(ATTEMPT_INTERVAL_MS);
      const writesBefore = store.writes.length;
      const shrunk = build({ store, time, files });
      expect(await shrunk.run()).toEqual({ status: 'failed', stage: 'check', reason: 'shrunk' });
      expect(current(store)).toEqual(before);
      // Nothing but the attempt marker.
      expect(store.writes.slice(writesBefore).map(({ key }) => key)).toEqual([ATTEMPT_KEY]);
    }

    time.advance(ATTEMPT_INTERVAL_MS);
    const ninety = build({ store, time, files: { sets: setsWith(90), minifigs: minifigsWith(90) } });
    expect(await ninety.run()).toMatchObject({ status: 'built', written: true, counts: { sets: 90, minifigs: 90 } });
  });

  it('[CAT-7] refuses a first build that holds no sets', async () => {
    const { run, store } = build({ files: { sets: 'set_num,name,year,theme_id,num_parts,img_url\n' } });
    expect(await run()).toEqual({ status: 'failed', stage: 'check', reason: 'empty' });
    expect(store.objects.has(CURRENT_KEY)).toBe(false);
  });

  it('[CAT-7] a failed download writes nothing but the attempt marker and leaves the previous index in place', async () => {
    const store = memoryStore();
    const time = clock();
    await build({ store, time }).run();
    const before = current(store);
    const keysBefore = [...store.objects.keys()].sort();
    time.advance(ATTEMPT_INTERVAL_MS);
    const writesBefore = store.writes.length;
    expect(await build({ store, time, script: { sets: () => new Response('gone', { status: 404 }) } }).run()).toMatchObject({ status: 'failed', stage: 'download' });
    expect(store.writes.slice(writesBefore).map(({ key }) => key)).toEqual([ATTEMPT_KEY]);
    expect(current(store)).toEqual(before);
    expect([...store.objects.keys()].sort()).toEqual(keysBefore);
  });
});

describe('buildSetIndex: writing', () => {
  it('[CAT-7] writes the index under a key named by its content hash, then the current pointer that names it', async () => {
    const { run, store } = build();
    const outcome = (await run()) as Extract<BuildOutcome, { status: 'built' }>;
    const pointer = current(store);
    expect(pointer.version).toMatch(/^[0-9a-f]{64}$/);
    expect(pointer.version).toBe(outcome.version);
    expect(pointer.key).toBe(versionKey(pointer.version));
    expect(pointer.key.startsWith(SET_INDEX_PREFIX)).toBe(true);
    expect(store.writes.map(({ key, contentType }) => [key, contentType])).toEqual([
      [ATTEMPT_KEY, 'application/json'],
      [pointer.key, 'application/gzip'],
      [CURRENT_KEY, 'application/json'],
    ]);
    expect(outcome.bytes).toBe(store.objects.get(pointer.key)?.byteLength);
    // Every key it wrote is under the index's prefix.
    for (const key of store.objects.keys()) expect(key.startsWith(SET_INDEX_PREFIX)).toBe(true);
  });

  it('[CAT-7] an unchanged build writes nothing new, a day later and with newer files alike', async () => {
    const store = memoryStore();
    const time = clock();
    const first = (await build({ store, time }).run()) as Extract<BuildOutcome, { status: 'built' }>;
    time.advance(ATTEMPT_INTERVAL_MS);
    const writesBefore = store.writes.length;
    const again = await build({ store, time }).run();
    expect(again).toMatchObject({ status: 'built', written: false, version: first.version });
    expect(store.writes.slice(writesBefore).map(({ key }) => key)).toEqual([ATTEMPT_KEY]);
  });

  it('[CAT-7] keeps the previous version until the next build replaces it, and no older one', async () => {
    const store = memoryStore();
    const time = clock();
    const versions: string[] = [];
    for (const count of [100, 101, 102]) {
      const outcome = (await build({ store, time, files: { sets: setsWith(count) } }).run()) as Extract<BuildOutcome, { status: 'built' }>;
      versions.push(outcome.version);
      time.advance(ATTEMPT_INTERVAL_MS);
    }
    const [oldest, previous, latest] = versions as [string, string, string];
    expect(current(store).version).toBe(latest);
    expect(store.objects.has(versionKey(latest))).toBe(true);
    expect(store.objects.has(versionKey(previous))).toBe(true);
    expect(store.objects.has(versionKey(oldest))).toBe(false);
  });

  it('[CAT-7] a failed write of the pointer leaves the previous index current', async () => {
    const store = memoryStore();
    const time = clock();
    await build({ store, time }).run();
    const before = current(store);
    time.advance(ATTEMPT_INTERVAL_MS);
    store.fail('put', CURRENT_KEY);
    expect(await build({ store, time, files: { sets: setsWith(10) } }).run()).toEqual({ status: 'failed', stage: 'write', reason: 'storage' });
    expect(current(store)).toEqual(before);
    // The new version it wrote first is taken away again.
    expect([...store.objects.keys()].filter((key) => /[0-9a-f]{64}/.test(key))).toEqual([before.key]);
  });

  it('[CAT-7] a missing current pointer reads as no index, and the first build writes the first one', async () => {
    const { run, store } = build();
    expect(store.objects.size).toBe(0);
    expect(await run()).toMatchObject({ status: 'built', written: true });
    expect(store.objects.has(CURRENT_KEY)).toBe(true);
  });

  it('[CAT-7] a pointer it can’t read fails the check before any fetch, and writes nothing', async () => {
    const store = memoryStore();
    store.fail('get', CURRENT_KEY);
    const { run, source } = build({ store });
    expect(await run()).toEqual({ status: 'failed', stage: 'check', reason: 'storage' });
    expect(source.calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });
});

describe('buildSetIndex: once in 24 hours', () => {
  it('[CAT-8] writes the attempt marker with the attempt’s time before its first fetch', async () => {
    const store = memoryStore();
    const time = clock();
    const order: string[] = [];
    const put = store.store.put.bind(store.store);
    store.store.put = async (key, body, contentType) => {
      order.push(`put:${key}`);
      return put(key, body, contentType);
    };
    const source = rebrickable();
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      order.push(`fetch:${String(args[0])}`);
      return source.fetch(...args);
    }) as typeof fetch;
    await buildSetIndex({ store: store.store, fetch: fetchImpl, now: time.now, sleep: time.sleep });
    expect(order[0]).toBe(`put:${ATTEMPT_KEY}`);
    expect(order[1]).toMatch(/^fetch:/);
    expect(JSON.parse(store.text(ATTEMPT_KEY) ?? 'null')).toEqual({ attemptedAt: new Date(time.now()).toISOString() });
  });

  it('[CAT-8] a build less than 24 hours after an attempt fetches nothing and is skipped, whether that attempt built, failed or changed nothing', async () => {
    for (const script of [{}, { sets: () => new Response('gone', { status: 404 }) }] as Script[]) {
      const store = memoryStore();
      const time = clock();
      const attemptedAt = new Date(time.now()).toISOString();
      await build({ store, time, script }).run();
      time.advance(ATTEMPT_INTERVAL_MS - 1);
      const writesBefore = store.writes.length;
      const again = build({ store, time });
      expect(await again.run()).toEqual({ status: 'skipped', lastAttemptAt: attemptedAt });
      expect(again.source.calls).toEqual([]);
      expect(store.writes.length).toBe(writesBefore);
      // At 24 hours it fetches again.
      time.advance(1);
      const later = build({ store, time });
      expect(await later.run()).toMatchObject({ status: 'built' });
      expect(later.source.calls.length).toBe(3);
    }
  });

  it('[CAT-8] a marker it can’t read, or that names a time to come, fetches nothing', async () => {
    const future = memoryStore({ [ATTEMPT_KEY]: JSON.stringify({ attemptedAt: '2027-01-01T00:00:00.000Z' }) });
    const ahead = build({ store: future });
    expect(await ahead.run()).toEqual({ status: 'skipped', lastAttemptAt: '2027-01-01T00:00:00.000Z' });
    expect(ahead.source.calls).toEqual([]);
    const garbled = memoryStore({ [ATTEMPT_KEY]: 'not json' });
    const unreadable = build({ store: garbled });
    expect(await unreadable.run()).toEqual({ status: 'failed', stage: 'check', reason: 'unreadable-marker' });
    expect(unreadable.source.calls).toEqual([]);
    const failing = memoryStore();
    failing.fail('get', ATTEMPT_KEY);
    const refused = build({ store: failing });
    expect(await refused.run()).toEqual({ status: 'failed', stage: 'check', reason: 'storage' });
    expect(refused.source.calls).toEqual([]);
  });

  it('[CAT-8] fetches nothing when the marker can’t be written', async () => {
    const store = memoryStore();
    store.fail('put', ATTEMPT_KEY);
    const { run, source } = build({ store });
    expect(await run()).toEqual({ status: 'failed', stage: 'write', reason: 'storage' });
    expect(source.calls).toEqual([]);
  });
});
