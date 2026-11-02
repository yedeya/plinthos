/**
 * The snapshot writer: it turns the public projection into the files visitors' phones load, and
 * puts them under `c/{token}/` in the private snapshot bucket, which the public distribution
 * serves (`infra/snapshot.ts`, [PUB-1]).
 *
 * It takes only the projection `./projection.ts` makes ([PUB-5]) and renders each file from it
 * alone: `catalogue.json` is the projection's `catalogue`, and the pages are what the renderers in
 * `./pages/` make of that same data. The token is the files' address and never their content
 * ([PUB-4]): every link inside them is relative.
 *
 * Each published photo is a copy ([PUB-13]): the bucket copies each stored size from the private
 * photo bucket to the public path the projection chose, `p/{random}.webp`, with the snapshot's own
 * headers and none of the source's metadata. The private key is the copy's source and is written
 * into no file. Copies and pages go in parallel, `WRITE_CONCURRENCY` at a time.
 *
 * A failed write leaves the previous snapshot in place ([OPS-6]). Every file is rendered before
 * the first is written, the landing page last of all, and the files as they were are read first:
 * when a write fails, each file already written is put back as it was, or deleted if it is new.
 * Each publish copies its photos to new paths, so a failed one only deletes its own copies.
 * Publishes take turns (`./projection.ts`, [PUB-8]), so the files as they were are the last
 * publish's whole. Once a publish has succeeded, `removeStale` deletes every object under `c/`
 * this snapshot does not hold: the previous snapshot's photos and pages, and after a rotation,
 * the old token's whole folder ([PUB-15]).
 */
import { STORED_KEY } from '../photos/keys';
import { renderCataloguePages } from './pages';
import { assertPublicProjection, PUBLIC_PHOTO_PATH, type PublicProjection } from './projection';
import type { CatalogueToken } from './token';

/** One stored object: its bytes and the two headers the distribution passes on. */
export interface SnapshotObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** The headers a copied photo is given in place of its source's. */
export interface CopyHeaders {
  readonly contentType: string;
  readonly cacheControl: string;
}

/** Where snapshots are kept: the bucket in deployed code (`./aws.ts`), a map in tests. */
export interface SnapshotStore {
  /** The object at `key`, or null when there is none. */
  get(key: string): Promise<SnapshotObject | null>;
  put(key: string, object: SnapshotObject): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`. */
  list(prefix: string): Promise<string[]>;
  /**
   * Copies a stored photo size, `photos/{random}.webp` in the private photo bucket, to `key` in
   * this bucket, with `headers` and none of the source's metadata ([PUB-13]).
   */
  copyPhoto(storedKey: string, key: string, headers: CopyHeaders): Promise<void>;
}

/** The prefix every snapshot lives under, and the only one the distribution may read ([PUB-1]). */
export const SNAPSHOT_PREFIX = 'c';

/**
 * Browsers keep a file a minute; the distribution keeps it a day, and each publish invalidates
 * the token's path, so a new snapshot is live within the invalidation's own minute or two.
 */
export const SNAPSHOT_CACHE_CONTROL = 'public, max-age=60, s-maxage=86400';

/** A published photo's type: the stored sizes are WebP already ([PHOTO-4]). */
export const PHOTO_CONTENT_TYPE = 'image/webp';

/**
 * How many copies or writes run at once. A copy inside one region takes tens of milliseconds, so
 * about 1,100 copies (140 sets with four photos of two sizes each) take a few seconds, well
 * inside the server function's 55 seconds (`tests/server/publish/catalogue.test.ts` measures it
 * against a store of that latency). The SDK's default pool holds 50 sockets.
 */
export const WRITE_CONCURRENCY = 32;

/** The token's own path on the distribution, and the folder its files are under. */
export function snapshotPath(token: CatalogueToken): string {
  return `/${SNAPSHOT_PREFIX}/${token}/`;
}

/** One file of a snapshot, by its name inside the token's folder. */
export interface SnapshotFile {
  /** `''` is the folder itself, which `/c/{token}/` is: S3 has no index document behind CloudFront. */
  readonly name: string;
  readonly object: SnapshotObject;
}

/** A page's path: relative, plain segments, nothing that could climb out of the token's folder. */
const PAGE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export class InvalidPagePathError extends Error {
  override name = 'InvalidPagePathError';
}

/**
 * Renders every file of a snapshot from the projection alone: the data file first, then the
 * assets and the item pages, the landing page last. A page `x/index.html` is written at its folder
 * `x/` too, since S3 has no index document behind CloudFront.
 */
export function renderSnapshot(projection: PublicProjection): SnapshotFile[] {
  assertPublicProjection(projection);
  const encode = (text: string) => new TextEncoder().encode(text);
  const file = (name: string, text: string, contentType: string): SnapshotFile => ({
    name,
    object: { body: encode(text), contentType, cacheControl: SNAPSHOT_CACHE_CONTROL },
  });
  const pages = renderCataloguePages(projection.catalogue);
  const files: SnapshotFile[] = [];
  const landing: SnapshotFile[] = [];
  const seen = new Set<string>(['catalogue.json']);
  for (const page of pages) {
    if (!PAGE_PATH.test(page.path) || page.path.split('/').some((segment) => segment === '.' || segment === '..') || PUBLIC_PHOTO_PATH.test(page.path)) {
      throw new InvalidPagePathError('A page renderer returned a path outside the snapshot’s pages.');
    }
    const names = page.path.endsWith('index.html') ? [page.path, page.path.slice(0, -'index.html'.length)] : [page.path];
    for (const name of names) {
      if (seen.has(name)) throw new InvalidPagePathError('Two pages share one path.');
      seen.add(name);
      (page.path === 'index.html' ? landing : files).push(file(name, page.body, page.contentType));
    }
  }
  if (landing.length === 0) throw new InvalidPagePathError('The page renderers returned no landing page.');
  return [file('catalogue.json', `${JSON.stringify(projection.catalogue)}\n`, 'application/json; charset=utf-8'), ...files, ...landing];
}

export class SnapshotWriteError extends Error {
  override name = 'SnapshotWriteError';
  /** Whether every file was put back as it was before the write. */
  readonly restored: boolean;
  constructor(message: string, options: { cause: unknown; restored: boolean }) {
    super(message, { cause: options.cause });
    this.restored = options.restored;
  }
}

export interface WrittenSnapshot {
  /** How many files were written, photos included, and the pages' and data's bytes. */
  readonly files: number;
  readonly bytes: number;
  /** How many items and photo copies the snapshot holds. */
  readonly items: number;
  readonly photos: number;
  /** Puts every file back as it was before this write: for a failure after the write. */
  restore(): Promise<void>;
  /**
   * Deletes every object under `c/` that this snapshot doesn't hold, under its own token or any
   * other: for after the publish has succeeded. Answers how many it deleted.
   */
  removeStale(): Promise<number>;
}

/**
 * Runs `work` on every value, at most `limit` at once. After a failure it starts no more, waits
 * for those already running, so none lands after the caller puts things back, then throws the
 * first error.
 */
export async function eachLimited<T>(values: readonly T[], limit: number, work: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined && next < values.length) {
      const value = values[next] as T;
      next += 1;
      try {
        await work(value);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/** Writes a snapshot under the token's prefix ([PUB-5], [PUB-13], [OPS-6]). */
export async function writeSnapshot(store: SnapshotStore, token: CatalogueToken, projection: PublicProjection): Promise<WrittenSnapshot> {
  const files = renderSnapshot(projection);
  const folder = `${SNAPSHOT_PREFIX}/${token}/`;
  const key = (name: string) => `${folder}${name}`;
  for (const { from, to } of projection.photoCopies) {
    if (!STORED_KEY.test(from) || !PUBLIC_PHOTO_PATH.test(to)) throw new SnapshotWriteError('A photo copy names a key the writer refuses.', { cause: undefined, restored: true });
  }

  const previous = new Map<string, SnapshotObject | null>();
  try {
    await eachLimited(files, WRITE_CONCURRENCY, async ({ name }) => void previous.set(key(name), await store.get(key(name))));
  } catch (error) {
    // Nothing is written yet, so the previous snapshot is untouched.
    throw new SnapshotWriteError('Reading the previous snapshot failed, so nothing was written.', { cause: error, restored: true });
  }

  // A key counts as touched from the moment its write starts: a write whose answer was lost may
  // still have landed.
  const touched = new Set<string>();
  const restore = async () => {
    // The landing page goes back first, so it never names a file that is gone; then the rest.
    const landing = [key(''), key('index.html')].filter((name) => touched.has(name));
    for (const name of landing) await putBack(store, name, previous.get(name) ?? null);
    const rest = [...touched].filter((name) => !landing.includes(name));
    await eachLimited(rest, WRITE_CONCURRENCY, (name) => putBack(store, name, previous.get(name) ?? null));
  };

  const landingNames = new Set(['', 'index.html']);
  try {
    await eachLimited(projection.photoCopies, WRITE_CONCURRENCY, async ({ from, to }) => {
      touched.add(key(to));
      await store.copyPhoto(from, key(to), { contentType: PHOTO_CONTENT_TYPE, cacheControl: SNAPSHOT_CACHE_CONTROL });
    });
    await eachLimited(
      files.filter(({ name }) => !landingNames.has(name)),
      WRITE_CONCURRENCY,
      async ({ name, object }) => {
        touched.add(key(name));
        await store.put(key(name), object);
      },
    );
    for (const { name, object } of files.filter(({ name: n }) => landingNames.has(n))) {
      touched.add(key(name));
      await store.put(key(name), object);
    }
  } catch (error) {
    const restored = await restore().then(
      () => true,
      () => false,
    );
    throw new SnapshotWriteError('Writing the snapshot failed.', { cause: error, restored });
  }

  const holds = new Set([...files.map(({ name }) => key(name)), ...projection.photoCopies.map(({ to }) => key(to))]);
  const removeStale = async () => {
    const stale = (await store.list(`${SNAPSHOT_PREFIX}/`)).filter((name) => !holds.has(name));
    await eachLimited(stale, WRITE_CONCURRENCY, (name) => store.delete(name));
    return stale.length;
  };

  return {
    files: files.length + projection.photoCopies.length,
    bytes: files.reduce((sum, { object }) => sum + object.body.byteLength, 0),
    items: projection.catalogue.items.length,
    photos: projection.photoCopies.length,
    restore,
    removeStale,
  };
}

/** Puts one object back as it was: the previous bytes, or nothing if it is new. */
async function putBack(store: SnapshotStore, key: string, object: SnapshotObject | null): Promise<void> {
  if (object === null) await store.delete(key);
  else await store.put(key, object);
}
