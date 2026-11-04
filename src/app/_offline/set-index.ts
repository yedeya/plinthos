/**
 * The set index on the device (brief #252, Issue B, [CAT-10], [CAT-11]): Rebrickable's sets and
 * minifigures, as the weekly build wrote them (`src/server/catalogue/set-index/`), kept in an
 * IndexedDB database of its own and searched there as the owner types, online and offline.
 *
 * - **The check:** when the admin opens online, `checkSetIndexOnce` asks
 *   `GET /admin/api/sets/index` once per tab, with the version the device holds as
 *   `If-None-Match`. A 304 keeps the stored index; a 404 means none has been built yet, and keeps
 *   whatever the device holds. A check that failed is asked again when the next admin page opens.
 * - **The swap:** a new index replaces the stored one only once it has been fully read, inflated
 *   (gzip's trailer proves it whole) and parsed, in one transaction with its version and build
 *   time, so a failed download keeps the old one and the device is never left without one.
 * - **The search:** `searchIndex`, a pure function over the stored rows, ranked by `rankSets`'s
 *   own rules (`src/server/catalogue/rank.ts`), so the phone and the server rank alike.
 *
 * The index holds only Rebrickable's public facts ([CAT-6]), but it is an admin route's answer:
 * the service worker caches it nowhere ([SYNC-6]), and logout deletes this database with the
 * queue (`./sign-out.ts`, [SYNC-9]). Nothing from it reaches the server: a picked set saves its
 * set number, and the server fills `lego_set` from its own lookup when the item syncs ([ITEM-4]).
 *
 * It imports nothing of the server's but the pure ranking rules and the index's row shapes, so
 * the device's bundle and the data-free shell take it.
 */
import { RANK, rankerFor } from '../../server/catalogue/rank';
import { SET_IMAGE_BASE, SET_INDEX_FORMAT, type MinifigRow, type SetRow, type ThemeRow } from '../../server/catalogue/set-index/rows';
import { normalizeSetNumber, SEARCH_MAX_RESULTS, SEARCH_MIN_LENGTH, type CatalogueSet } from './items';

/** The admin route that serves the index (`src/app/admin/api/sets/index/route.ts`, [CAT-9]). */
export const SET_INDEX_ENDPOINT = '/admin/api/sets/index';

/** The index's own database, apart from the queue's, so logout can delete each whole. */
export const SET_INDEX_DATABASE = 'plinthos-set-index';
const STORE = 'index';
const VERSION = 1;
/** The two records of the store: the small one `/admin` reads, and the rows the search reads. */
const META = 'meta';
const ROWS = 'rows';

/** After this, `/admin` says the index on the device is old: two weekly builds missed ([CAT-10]). */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** How long the check and its download may take: about 640 KB on a phone's connection. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

/** The most the device reads of a download, gzipped and inflated: several times today's index. */
export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_INFLATED_BYTES = 40 * 1024 * 1024;

/** Where a tab records that it has asked the route, so it asks once when the admin opens. */
export const SET_INDEX_CHECKED_KEY = 'plinthos:set-index-checked';

/** The event sent when a new index has been stored, which the entry form and `/admin` reload on. */
export const SET_INDEX_CHANGED = 'plinthos:set-index-changed';

/** What `/admin` shows of the stored index. */
export interface StoredIndexMeta {
  readonly version: string;
  /** When the build that wrote it ran, as an ISO 8601 instant. */
  readonly builtAt: string;
  readonly counts: { readonly sets: number; readonly minifigs: number; readonly themes: number };
}

/** The stored rows, as the build wrote them. */
export interface StoredIndexRows {
  readonly themes: readonly ThemeRow[];
  readonly sets: readonly SetRow[];
  readonly minifigs: readonly MinifigRow[];
}

/** A downloaded index, checked: what the device stores. */
export interface ParsedIndex extends StoredIndexRows {
  readonly builtAt: string;
}

/** One result of the search: a set or a minifigure, in the shape the form shows a set in. */
export interface IndexEntry extends CatalogueSet {
  readonly kind: 'set' | 'minifig';
}

/** The stored index, ready to search. */
export interface SearchableIndex {
  readonly version: string;
  readonly builtAt: string;
  /** Every set, then every minifigure, in the index's own order. */
  readonly entries: readonly IndexEntry[];
  /** Each entry by its number, lowercased. */
  readonly byNumber: ReadonlyMap<string, IndexEntry>;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('an IndexedDB request failed'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('an IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('an IndexedDB transaction was aborted'));
  });
}

/** Runs `use` on the index's database and closes it at once, so nothing here holds it open against logout's deletion. */
async function withDatabase<T>(factory: IDBFactory, use: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const opening = factory.open(SET_INDEX_DATABASE, VERSION);
  opening.onupgradeneeded = () => {
    if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
  };
  const database = await promised(opening);
  database.onversionchange = () => database.close();
  try {
    return await use(database);
  } finally {
    database.close();
  }
}

async function readRecord<T>(factory: IDBFactory, key: string): Promise<T | null> {
  return withDatabase(factory, async (database) => {
    const found = (await promised(database.transaction(STORE, 'readonly').objectStore(STORE).get(key))) as T | undefined;
    return found ?? null;
  });
}

/** What the device holds of the index, without its rows, or null when it holds none. */
export function readIndexMeta(factory: IDBFactory = indexedDB): Promise<StoredIndexMeta | null> {
  return readRecord<StoredIndexMeta>(factory, META);
}

/** Stores a new index, its rows and what `/admin` shows of it, in one transaction: all of it or none. */
async function storeIndex(factory: IDBFactory, version: string, index: ParsedIndex): Promise<void> {
  const meta: StoredIndexMeta = { version, builtAt: index.builtAt, counts: { sets: index.sets.length, minifigs: index.minifigs.length, themes: index.themes.length } };
  const rows: StoredIndexRows = { themes: index.themes, sets: index.sets, minifigs: index.minifigs };
  await withDatabase(factory, async (database) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    store.put(rows, ROWS);
    store.put(meta, META);
    await done(transaction);
  });
}

/**
 * Deletes the index's database whole: logout's step ([CAT-10], [SYNC-9]). It waits for every other
 * connection to close, so another tab can block it; logout gives up on it after a while and stays
 * signed in.
 */
export async function deleteSetIndex(factory: IDBFactory = indexedDB): Promise<void> {
  loaded = null;
  await promised(factory.deleteDatabase(SET_INDEX_DATABASE));
}

const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string';

function isSetRow(row: unknown): row is SetRow {
  return Array.isArray(row) && (row.length === 5 || (row.length === 6 && isText(row[5]))) && isText(row[0]) && isText(row[1]) && isInt(row[2]) && isInt(row[3]) && isInt(row[4]);
}

function isMinifigRow(row: unknown): row is MinifigRow {
  return Array.isArray(row) && row.length === 3 && isText(row[0]) && isText(row[1]) && isInt(row[2]);
}

function isThemeRow(row: unknown): row is ThemeRow {
  return Array.isArray(row) && row.length === 3 && isInt(row[0]) && isText(row[1]) && (row[2] === null || isInt(row[2]));
}

/** An index as the build writes it (`src/server/catalogue/set-index/format.ts`), checked row by row; throws on anything else. */
export function parseSetIndex(value: unknown): ParsedIndex {
  const index = value as Partial<Record<'format' | 'builtAt' | 'themes' | 'sets' | 'minifigs', unknown>> | null;
  if (typeof index !== 'object' || index === null || index.format !== SET_INDEX_FORMAT) throw new Error('not a set index of a format this device reads');
  if (!isText(index.builtAt) || !/^\d{4}-\d{2}-\d{2}T/.test(index.builtAt) || Number.isNaN(Date.parse(index.builtAt))) throw new Error('the set index has no build time');
  const { themes, sets, minifigs } = index;
  if (!Array.isArray(themes) || !themes.every(isThemeRow)) throw new Error('the set index’s themes do not parse');
  if (!Array.isArray(sets) || !sets.every(isSetRow)) throw new Error('the set index’s sets do not parse');
  if (!Array.isArray(minifigs) || !minifigs.every(isMinifigRow)) throw new Error('the set index’s minifigures do not parse');
  return { builtAt: index.builtAt, themes, sets, minifigs };
}

/** Reads a body whole, refusing one past `cap` bytes. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`more than ${cap} bytes`);
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return whole;
}

/** Inflates the gzip file the route serves; rejects on one that is cut short, which gzip's trailer tells. */
async function inflate(bytes: Uint8Array): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const inflated = await readCapped(source.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), MAX_INFLATED_BYTES);
  return new TextDecoder('utf-8', { fatal: true }).decode(inflated);
}

/** The version an `ETag` names, or null when it names none. */
function versionOf(etag: string | null): string | null {
  const match = /^(?:W\/)?"([0-9a-f]{64})"$/.exec(etag?.trim() ?? '');
  return match?.[1] ?? null;
}

/** What a check came to: a new index stored, the stored one kept, none built yet, or a failure that kept the old one. */
export type IndexCheck = 'updated' | 'unchanged' | 'missing' | 'failed';

/**
 * Asks the route for the index, with the version the device holds, and stores a new one once it
 * is fully read and parsed ([CAT-10]). It never rejects: anything that goes wrong is `failed`,
 * and the device keeps what it held.
 */
export async function checkSetIndex(options: { readonly factory?: IDBFactory; readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}): Promise<IndexCheck> {
  const factory = options.factory ?? indexedDB;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    // A stored index that can't be read is downloaded again rather than trusted.
    const held = await readIndexMeta(factory).catch(() => null);
    const response = await send(SET_INDEX_ENDPOINT, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: held === null ? {} : { 'if-none-match': `"${held.version}"` },
      signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status === 304) return 'unchanged';
    if (response.status === 404) return 'missing';
    // Anything but the gzip file with its version, an ended session's sign-in page included, is no index.
    const version = versionOf(response.headers.get('etag'));
    if (response.status !== 200 || version === null || response.body === null || !/^application\/gzip\b/.test(response.headers.get('content-type') ?? '')) return 'failed';
    const index = parseSetIndex(JSON.parse(await inflate(await readCapped(response.body, MAX_DOWNLOAD_BYTES))));
    await storeIndex(factory, version, index);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SET_INDEX_CHANGED));
    return 'updated';
  } catch {
    return 'failed';
  }
}

/** Whether this tab has asked the route already; a browser that refuses storage asks on every page. */
function checkedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SET_INDEX_CHECKED_KEY) !== null;
  } catch {
    return false;
  }
}

function markChecked(): void {
  try {
    window.sessionStorage.setItem(SET_INDEX_CHECKED_KEY, new Date().toISOString());
  } catch {
    // Without storage, the next page asks again: a 304 costs little.
  }
}

let checking: Promise<IndexCheck> | null = null;

/**
 * The check when the admin opens online ([CAT-10]): once per tab, shared by whatever asks at the
 * same time. `skipped` offline, without IndexedDB, and once this tab has had an answer; a check
 * that failed is asked again on the next page.
 */
export function checkSetIndexOnce(): Promise<IndexCheck | 'skipped'> {
  if (typeof indexedDB === 'undefined' || !navigator.onLine || checkedThisSession()) return Promise.resolve('skipped');
  checking ??= checkSetIndex().then((result) => {
    checking = null;
    if (result !== 'failed') markChecked();
    return result;
  });
  return checking;
}

/** Whether an index built at `builtAt` is older than 14 days ([CAT-10]). */
export function isStale(builtAt: string, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(builtAt) > STALE_AFTER_MS;
}

/** A stock image's address: `<number>.jpg` under Rebrickable's base, the path the index names under it, its own https address, or none. */
function imageUrl(number: string, image: string | undefined): string | null {
  if (image === undefined) return `${SET_IMAGE_BASE}${number}.jpg`;
  if (image === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(image)) return image.startsWith('https://') ? image : null;
  return `${SET_IMAGE_BASE}${image}`;
}

/** The stored rows as search entries: every set with its theme's name, then every minifigure. */
export function toSearchable(version: string, index: ParsedIndex): SearchableIndex {
  const themes = new Map(index.themes.map(([id, name]) => [id, name]));
  const entries: IndexEntry[] = [];
  for (const [setNum, name, themeId, year, numParts, image] of index.sets) {
    entries.push({ kind: 'set', setNum, name, theme: themes.get(themeId) ?? null, year, numParts, imageUrl: imageUrl(setNum, image) });
  }
  for (const [figNum, name, numParts] of index.minifigs) {
    entries.push({ kind: 'minifig', setNum: figNum, name, theme: null, year: null, numParts, imageUrl: imageUrl(figNum, undefined) });
  }
  const byNumber = new Map<string, IndexEntry>();
  for (const entry of entries) if (!byNumber.has(entry.setNum.toLowerCase())) byNumber.set(entry.setNum.toLowerCase(), entry);
  return { version, builtAt: index.builtAt, entries, byNumber };
}

let loaded: SearchableIndex | null = null;

/** The stored index, ready to search, or null when the device holds none or can't read it. Read again only when its version changed. */
export async function loadSearchIndex(factory: IDBFactory = indexedDB): Promise<SearchableIndex | null> {
  try {
    const meta = await readIndexMeta(factory);
    if (meta === null) return (loaded = null);
    if (loaded?.version === meta.version) return loaded;
    const rows = await readRecord<StoredIndexRows>(factory, ROWS);
    if (rows === null) return (loaded = null);
    return (loaded = toSearchable(meta.version, { builtAt: meta.builtAt, ...rows }));
  } catch {
    return null;
  }
}

/**
 * Searches the index ([CAT-11]): from 2 characters, sets and minifigures together, at most 10,
 * ranked by `rankSets`'s rules. An entry matches when `rankSets` would rank it above the rest: its
 * number is the query's, a variant of it or starts with it, or its name holds it. Within a rank,
 * the index's own order, sets first. It sends nothing.
 */
export function searchIndex(index: SearchableIndex, query: string, max: number = SEARCH_MAX_RESULTS): IndexEntry[] {
  const trimmed = query.trim();
  if (trimmed.length < SEARCH_MIN_LENGTH) return [];
  const rank = rankerFor(trimmed);
  // One bucket per rank that matches; a full bucket takes nothing more, since nothing after it can pass it.
  const buckets: IndexEntry[][] = Array.from({ length: RANK.rest }, () => []);
  for (const entry of index.entries) {
    const bucket = buckets[rank(entry)];
    if (bucket !== undefined && bucket.length < max) bucket.push(entry);
  }
  return buckets.flat().slice(0, max);
}

/** Whether the index holds a typed number, `10294` read as `10294-1` ([CAT-11]). */
export function holdsNumber(index: SearchableIndex, typed: string): boolean {
  return index.byNumber.has(normalizeSetNumber(typed).toLowerCase());
}
