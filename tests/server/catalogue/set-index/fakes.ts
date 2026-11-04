/**
 * Stand-ins for the set index's builder: Rebrickable's three archive files built from made-up
 * rows, a scripted `fetch` that records every URL it is asked for, and an in-memory store. No test
 * reaches Rebrickable or S3.
 */
import { gzipSync } from 'node:zlib';
import { DOWNLOAD_BASE, type SourceName } from '../../../../src/server/catalogue/set-index/build';
import type { SetIndexStore } from '../../../../src/server/catalogue/set-index/format';

/** A column no index field comes from, so a test can show it is left out. */
export const CANARY_COLUMN = 'canary_column';
export const CANARY_VALUE = 'canary-value-7d1e0b';

export const SETS_CSV = [
  `set_num,name,year,theme_id,num_parts,img_url,${CANARY_COLUMN}`,
  `90001-1,Made-up Lighthouse,2031,9101,1234,https://cdn.rebrickable.com/media/sets/90001-1.jpg,${CANARY_VALUE}`,
  `90002-1,"Sticker Sheet for Sets 90001-1, 90003-2",2032,9102,1,https://cdn.rebrickable.com/media/sets/90002-1/90210.jpg,${CANARY_VALUE}`,
  `90003-2,"The ""Pretend"" Harbour",2033,9102,567,,${CANARY_VALUE}`,
  `90004-1,Made-up Windmill,2034,9101,890,https://images.example.test/90004-1.png,${CANARY_VALUE}`,
].join('\n');

export const THEMES_CSV = ['id,name,parent_id', '9101,Imaginary Icons,', '9102,Pretend City,9101', '9103,"Harbours, Docks",9102'].join('\n');

export const MINIFIGS_CSV = [
  `fig_num,name,num_parts,img_url,${CANARY_COLUMN}`,
  `fig-900001,Made-up Lighthouse Keeper,4,https://cdn.rebrickable.com/media/sets/fig-900001.jpg,${CANARY_VALUE}`,
  `fig-900002,"Pretend Sailor, with Cap",5,https://cdn.rebrickable.com/media/sets/fig-900002.jpg,${CANARY_VALUE}`,
].join('\n');

/** The made-up files' `Last-Modified` values. */
export const LAST_MODIFIED: Record<SourceName, string> = {
  sets: 'Mon, 02 Nov 2026 06:10:00 GMT',
  themes: 'Mon, 02 Nov 2026 06:11:00 GMT',
  minifigs: 'Mon, 02 Nov 2026 06:12:00 GMT',
};

export type Script = Partial<Record<SourceName, (attempt: number) => Response | 'throw' | 'hang'>>;

/** A gzipped file as Rebrickable's CDN answers it. */
export function archive(csv: string, name: SourceName, headers: Record<string, string> = {}): Response {
  return new Response(gzipSync(Buffer.from(csv, 'utf8')), { status: 200, headers: { 'content-type': 'application/x-gzip', 'last-modified': LAST_MODIFIED[name], ...headers } });
}

/** The three made-up files, each answered by the script's own answer where it has one. */
export function rebrickable(files: Partial<Record<SourceName, string>> = {}, script: Script = {}) {
  const calls: string[] = [];
  const attempts = new Map<SourceName, number>();
  const csv: Record<SourceName, string> = { sets: SETS_CSV, themes: THEMES_CSV, minifigs: MINIFIGS_CSV, ...files };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const name = (Object.keys(csv) as SourceName[]).find((candidate) => url === `${DOWNLOAD_BASE}${candidate}.csv.gz`);
    if (name === undefined) return new Response('not found', { status: 404 });
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    const answer = script[name]?.(attempt) ?? archive(csv[name], name);
    if (answer === 'throw') throw new TypeError('fetch failed');
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return answer;
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

export type StoreOperation = 'get' | 'put' | 'delete' | 'list';

/** An in-memory bucket prefix, with every write recorded and any operation made to fail. */
export function memoryStore(initial: Record<string, Uint8Array | string> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? Buffer.from(value) : value]));
  const writes: { op: 'put' | 'delete'; key: string; contentType?: string }[] = [];
  const failing = new Set<string>();
  const fails = (op: StoreOperation, key: string) => failing.has(`${op}:${key}`) || failing.has(`${op}:*`);
  const store: SetIndexStore = {
    async get(key) {
      if (fails('get', key)) throw new Error('made-up storage failure');
      return objects.get(key) ?? null;
    },
    async put(key, body, contentType) {
      if (fails('put', key)) throw new Error('made-up storage failure');
      writes.push({ op: 'put', key, contentType });
      objects.set(key, body);
    },
    async delete(key) {
      if (fails('delete', key)) throw new Error('made-up storage failure');
      writes.push({ op: 'delete', key });
      objects.delete(key);
    },
    async list(prefix) {
      if (fails('list', prefix)) throw new Error('made-up storage failure');
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
  return {
    store,
    objects,
    writes,
    /** Makes an operation fail, on one key or on every key (`*`). */
    fail: (op: StoreOperation, key = '*') => failing.add(`${op}:${key}`),
    text: (key: string) => {
      const body = objects.get(key);
      return body === undefined ? undefined : Buffer.from(body).toString('utf8');
    },
  };
}

/** A fake clock that `sleep` advances. */
export function clock(start = Date.parse('2026-11-09T08:00:00Z')) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    sleeps,
  };
}
