/**
 * `buildSetIndex` (brief #252, Issue A, [CAT-6] to [CAT-8]): the one function that builds the set
 * index, from Rebrickable's `sets.csv.gz`, `themes.csv.gz` and `minifigs.csv.gz` alone, and writes
 * it under `set-index/` of the private photo bucket (`./format.ts`). The builder's handler
 * (`./worker.ts`) calls it once a week and logs what it answers.
 *
 * - **Once in 24 hours** ([CAT-8]). Rebrickable allows automated downloads at most once a day. A
 *   marker under `set-index/` holds the time of the last attempt that went on to fetch, whatever it
 *   came to; a build less than 24 hours after it fetches nothing and answers `skipped`. The marker
 *   is written before the first fetch, and a marker that can't be read or written stops the build
 *   before it fetches. Only the three archive files are fetched, never a Rebrickable web page, and a
 *   redirect is not followed.
 * - **Each download** ([CAT-7]) is aborted after `DOWNLOAD_TIMEOUT_MS`, retried at most
 *   `MAX_RETRIES` times with exponential backoff on a network failure, a timeout, a 429 or a 5xx,
 *   and refused past `MAX_COMPRESSED_BYTES` as it arrives and past `MAX_DECOMPRESSED_BYTES` as it
 *   inflates. The three together stay within `BUILD_BUDGET_MS`, inside the function's 2-minute
 *   timeout: a retry that would end past it is not started.
 * - **Rows** that don't parse, a wrong field count or a number that isn't one, are skipped and
 *   counted. A file that lacks a column the index needs, or whose quoted field never closes, fails
 *   the build.
 * - **The check** ([CAT-7]): a build whose sets or minifigures number fewer than 90% of the current
 *   index's, or with none at all, writes nothing.
 * - **The write**: the index under its version's key, then the pointer, then the deletion of every
 *   version but the new one and the one it replaced. A build whose version is the current one's
 *   writes nothing. A failed pointer write takes the new version away again, so the previous index
 *   stays current and nothing but the marker is left behind.
 *
 * It never throws: every outcome is an answer, with the stage a failure happened at. It reads
 * nothing from the database, and imports nothing that could (`tests/server/catalogue/set-index/build.test.ts`).
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CsvError, parseCsv } from './csv';
import {
  ATTEMPT_KEY,
  AttemptMarker,
  CURRENT_KEY,
  isVersionKey,
  parsePointer,
  SET_IMAGE_BASE,
  SET_INDEX_FORMAT,
  SET_INDEX_PREFIX,
  versionKey,
  type MinifigRow,
  type Pointer,
  type SetIndex,
  type SetIndexStore,
  type SetRow,
  type SourceName,
  type ThemeRow,
} from './format';

export type { SourceName } from './format';

/** Where Rebrickable's download files are, and the only addresses the builder fetches ([CAT-8]). */
export const DOWNLOAD_BASE = 'https://cdn.rebrickable.com/media/downloads/';
/** The three files, in the order they are fetched. */
export const SOURCES: readonly SourceName[] = ['sets', 'themes', 'minifigs'];

/** How long one download may take, its body included ([CAT-7]). */
export const DOWNLOAD_TIMEOUT_MS = 30_000;
/** How many times a download is tried again ([CAT-7]). */
export const MAX_RETRIES = 2;
/** The first retry's backoff; each next one doubles it. */
export const BASE_BACKOFF_MS = 1_000;
/** What the downloads may take together, inside the function's 2-minute timeout. */
export const BUILD_BUDGET_MS = 100_000;
/** The largest file accepted as it arrives: the largest of the three is about 0.5 MB (brief #252, §1). */
export const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
/** The largest file accepted once inflated. */
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
/** The least share of the current index's sets and minifigures a build must hold, as tenths ([CAT-7]). */
export const MIN_SHARE_TENTHS = 9;
/** How long after an attempt the next one may fetch ([CAT-8]). */
export const ATTEMPT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Where a build failed: before fetching (`check` covers reading the marker and the pointer), or later. */
export type Stage = 'download' | 'parse' | 'check' | 'write';

export type BuildOutcome =
  | {
      readonly status: 'built';
      /** False when the build's version was already the current one, so nothing new was written. */
      readonly written: boolean;
      readonly version: string;
      readonly counts: Readonly<Record<SourceName, number>>;
      readonly skippedRows: Readonly<Record<SourceName, number>>;
      /** The gzipped index's size. */
      readonly bytes: number;
      /** False when deleting an older version failed; the next build tries again. */
      readonly pruned: boolean;
    }
  | { readonly status: 'skipped'; readonly lastAttemptAt: string }
  | { readonly status: 'failed'; readonly stage: Stage | 'unknown'; readonly reason: string; readonly file?: SourceName };

export interface BuildDependencies {
  readonly store: SetIndexStore;
  readonly fetch?: typeof fetch;
  /** Milliseconds, on any clock that `sleep` advances. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

class BuildFailure extends Error {
  override name = 'BuildFailure';
  constructor(
    readonly stage: Stage,
    readonly reason: string,
    readonly file?: SourceName,
  ) {
    super(`${stage}: ${reason}`);
  }
}

/** The columns each file must have, by name, wherever they are. */
const COLUMNS = {
  sets: ['set_num', 'name', 'year', 'theme_id', 'num_parts', 'img_url'],
  themes: ['id', 'name', 'parent_id'],
  minifigs: ['fig_num', 'name', 'num_parts'],
} as const satisfies Record<SourceName, readonly string[]>;

type Attempt = { readonly kind: 'ok'; readonly body: Uint8Array; readonly lastModified: string | null } | { readonly kind: 'retry'; readonly reason: string };

export async function buildSetIndex(deps: BuildDependencies): Promise<BuildOutcome> {
  const { store } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stage: Stage = 'check';

  /** Reads the body, refusing it once more than the cap has arrived. */
  async function readCapped(body: ReadableStream<Uint8Array> | null, file: SourceName): Promise<Uint8Array> {
    if (body === null) return new Uint8Array();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_COMPRESSED_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BuildFailure('download', 'too-large', file);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /** One try of one file, aborted after its timeout or at the budget's end, whichever comes first. */
  async function attempt(file: SourceName, deadline: number): Promise<Attempt> {
    const timeoutMs = Math.min(DOWNLOAD_TIMEOUT_MS, deadline - now());
    if (timeoutMs <= 0) return { kind: 'retry', reason: 'timeout' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        // A redirect is answered, never followed: it could lead to a web page ([CAT-8]).
        response = await fetchImpl(`${DOWNLOAD_BASE}${file}.csv.gz`, { signal: controller.signal, redirect: 'manual' });
      } catch {
        return { kind: 'retry', reason: controller.signal.aborted ? 'timeout' : 'network' };
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'retry', reason: response.status === 429 ? 'rate-limited' : 'upstream' };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new BuildFailure('download', `http-${response.status}`, file);
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_COMPRESSED_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new BuildFailure('download', 'too-large', file);
      }
      try {
        return { kind: 'ok', body: await readCapped(response.body, file), lastModified: response.headers.get('last-modified') };
      } catch (error) {
        if (error instanceof BuildFailure) throw error;
        return { kind: 'retry', reason: controller.signal.aborted ? 'timeout' : 'network' };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function download(file: SourceName, deadline: number): Promise<{ text: string; lastModified: string | null }> {
    for (let retry = 0; ; retry += 1) {
      const result = await attempt(file, deadline);
      if (result.kind === 'ok') return { text: inflate(result.body, file), lastModified: result.lastModified };
      const delay = BASE_BACKOFF_MS * 2 ** retry;
      if (retry >= MAX_RETRIES || now() + delay >= deadline) throw new BuildFailure('download', result.reason, file);
      await sleep(delay);
    }
  }

  try {
    // The guard ([CAT-8]): nothing is fetched within 24 hours of the last attempt.
    const marker = await read(store, ATTEMPT_KEY);
    if (marker !== null) {
      const parsed = AttemptMarker.safeParse(parseJson(marker));
      if (!parsed.success) throw new BuildFailure('check', 'unreadable-marker');
      if (now() - Date.parse(parsed.data.attemptedAt) < ATTEMPT_INTERVAL_MS) return { status: 'skipped', lastAttemptAt: parsed.data.attemptedAt };
    }
    const currentBody = await read(store, CURRENT_KEY);
    let previous: Pointer | null = null;
    if (currentBody !== null) {
      try {
        previous = parsePointer(currentBody);
      } catch {
        throw new BuildFailure('check', 'unreadable-pointer');
      }
    }

    const started = now();
    const builtAt = new Date(started).toISOString();
    stage = 'write';
    await write(store, ATTEMPT_KEY, json({ attemptedAt: builtAt }), 'application/json');

    stage = 'download';
    const deadline = started + BUILD_BUDGET_MS;
    const files = {} as Record<SourceName, { text: string; lastModified: string | null }>;
    for (const file of SOURCES) files[file] = await download(file, deadline);

    stage = 'parse';
    const themes = parseThemes(files.themes.text);
    const sets = parseSets(files.sets.text);
    const minifigs = parseMinifigs(files.minifigs.text);
    const counts = { sets: sets.rows.length, themes: themes.rows.length, minifigs: minifigs.rows.length };
    const skippedRows = { sets: sets.skipped, themes: themes.skipped, minifigs: minifigs.skipped };

    stage = 'check';
    if (counts.sets === 0 || counts.minifigs === 0 || counts.themes === 0) throw new BuildFailure('check', 'empty');
    if (previous !== null && (counts.sets * 10 < previous.counts.sets * MIN_SHARE_TENTHS || counts.minifigs * 10 < previous.counts.minifigs * MIN_SHARE_TENTHS)) {
      throw new BuildFailure('check', 'shrunk');
    }

    const rows = { format: SET_INDEX_FORMAT, themes: themes.rows, sets: sets.rows, minifigs: minifigs.rows };
    const version = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const index: SetIndex = {
      format: SET_INDEX_FORMAT,
      builtAt,
      sources: { sets: files.sets.lastModified, themes: files.themes.lastModified, minifigs: files.minifigs.lastModified },
      themes: themes.rows,
      sets: sets.rows,
      minifigs: minifigs.rows,
    };
    const body = gzipSync(JSON.stringify(index), { level: 9 });
    if (previous?.version === version) return { status: 'built', written: false, version, counts, skippedRows, bytes: body.byteLength, pruned: true };

    stage = 'write';
    const key = versionKey(version);
    await write(store, key, body, 'application/gzip');
    const pointer: Pointer = { format: SET_INDEX_FORMAT, version, key, builtAt, counts };
    try {
      await write(store, CURRENT_KEY, json(pointer), 'application/json');
    } catch (error) {
      // Nothing names the new version: take it away, so the previous index is all that is left.
      await store.delete(key).catch(() => undefined);
      throw error;
    }
    return { status: 'built', written: true, version, counts, skippedRows, bytes: body.byteLength, pruned: await prune(store, [key, previous?.key]) };
  } catch (error) {
    if (error instanceof BuildFailure) return { status: 'failed', stage: error.stage, reason: error.reason, ...(error.file === undefined ? {} : { file: error.file }) };
    // Never the error's message: it is not ours.
    return { status: 'failed', stage, reason: error instanceof Error ? error.name : 'unknown' };
  }
}

/** A key's body, or null when the bucket doesn't hold it; a failed read fails the check. */
async function read(store: SetIndexStore, key: string): Promise<Uint8Array | null> {
  try {
    return await store.get(key);
  } catch {
    throw new BuildFailure('check', 'storage');
  }
}

async function write(store: SetIndexStore, key: string, body: Uint8Array, contentType: string): Promise<void> {
  try {
    await store.put(key, body, contentType);
  } catch {
    throw new BuildFailure('write', 'storage');
  }
}

/** Deletes every stored version but those kept; answers whether it could. */
async function prune(store: SetIndexStore, keep: readonly (string | undefined)[]): Promise<boolean> {
  try {
    for (const key of await store.list(SET_INDEX_PREFIX)) {
      if (isVersionKey(key) && !keep.includes(key)) await store.delete(key);
    }
    return true;
  } catch {
    return false;
  }
}

function json(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/** The file inflated, refused past the cap. */
function inflate(body: Uint8Array, file: SourceName): string {
  let inflated: Buffer;
  try {
    inflated = gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') throw new BuildFailure('download', 'too-large', file);
    throw new BuildFailure('parse', 'not-gzip', file);
  }
  return new TextDecoder().decode(inflated);
}

/** A file's records, each cut down to the named columns in their order, and how many had the wrong field count. */
function table(file: SourceName, text: string, columns: readonly string[]): { records: string[][]; skipped: number } {
  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) throw new BuildFailure('parse', 'unterminated-quote', file);
    throw error;
  }
  const [header, ...rows] = records;
  const positions = columns.map((column) => header?.indexOf(column) ?? -1);
  if (header === undefined || positions.includes(-1)) throw new BuildFailure('parse', 'missing-column', file);
  const kept: string[][] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.length === header.length) kept.push(positions.map((position) => row[position] ?? ''));
    else skipped += 1;
  }
  return { records: kept, skipped };
}

/** A whole number as the files write one, or undefined. */
function whole(text: string): number | undefined {
  return /^\d{1,9}$/.test(text) ? Number(text) : undefined;
}

function byKey<Row extends readonly unknown[]>(rows: Row[]): Row[] {
  return rows.sort((a, b) => (a[0] === b[0] ? 0 : (a[0] as string | number) < (b[0] as string | number) ? -1 : 1));
}

/** The stock image, only where it isn't `<set number>.jpg` under the base; an address elsewhere only over https. */
function imageOf(setNum: string, url: string): string | undefined {
  if (url === `${SET_IMAGE_BASE}${setNum}.jpg`) return undefined;
  if (url.startsWith(SET_IMAGE_BASE)) return url.slice(SET_IMAGE_BASE.length);
  return url.startsWith('https://') ? url : '';
}

function parseSets(text: string): { rows: SetRow[]; skipped: number } {
  const { records, skipped } = table('sets', text, COLUMNS.sets);
  const rows: SetRow[] = [];
  let invalid = 0;
  for (const [setNum = '', name = '', yearText = '', themeText = '', partsText = '', url = ''] of records) {
    const [year, themeId, parts] = [whole(yearText), whole(themeText), whole(partsText)];
    if (setNum === '' || name === '' || year === undefined || themeId === undefined || parts === undefined) {
      invalid += 1;
      continue;
    }
    const image = imageOf(setNum, url);
    rows.push(image === undefined ? [setNum, name, themeId, year, parts] : [setNum, name, themeId, year, parts, image]);
  }
  return { rows: byKey(rows), skipped: skipped + invalid };
}

function parseThemes(text: string): { rows: ThemeRow[]; skipped: number } {
  const { records, skipped } = table('themes', text, COLUMNS.themes);
  const rows: ThemeRow[] = [];
  let invalid = 0;
  for (const [idText = '', name = '', parentText = ''] of records) {
    const [id, parentId] = [whole(idText), parentText === '' ? null : whole(parentText)];
    if (id === undefined || name === '' || parentId === undefined) {
      invalid += 1;
      continue;
    }
    rows.push([id, name, parentId]);
  }
  return { rows: byKey(rows), skipped: skipped + invalid };
}

function parseMinifigs(text: string): { rows: MinifigRow[]; skipped: number } {
  const { records, skipped } = table('minifigs', text, COLUMNS.minifigs);
  const rows: MinifigRow[] = [];
  let invalid = 0;
  for (const [figNum = '', name = '', partsText = ''] of records) {
    const parts = whole(partsText);
    if (figNum === '' || name === '' || parts === undefined) {
      invalid += 1;
      continue;
    }
    rows.push([figNum, name, parts]);
  }
  return { rows: byKey(rows), skipped: skipped + invalid };
}
