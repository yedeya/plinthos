/**
 * The snapshot writer: it turns the public projection into the files buyers' phones load, and
 * puts them under `c/{token}/` in the private snapshot bucket, which the public distribution
 * serves (`infra/snapshot.ts`, [PUB-1]).
 *
 * It takes only the projection `./projection.ts` makes ([PUB-5]) and renders each file from it
 * alone, so a file holds nothing the projection doesn't. The token is the files' address and never
 * their content ([PUB-4]): every link inside them is relative.
 *
 * A failed write leaves the previous snapshot in place ([OPS-6]). Every file is rendered before
 * the first is written, the page last of all, and the files as they were are read first: when a
 * write fails, each file already written is put back as it was, or deleted if it is new. Publishes
 * take turns (`./projection.ts`, [PUB-8]), so the files as they were are the last publish's whole.
 */
import { assertPublicProjection, type PublicProjection } from './projection';
import type { CatalogueToken } from './token';

/** One stored object: its bytes and the two headers the distribution passes on. */
export interface SnapshotObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** Where snapshots are kept: the bucket in deployed code (`./aws.ts`), a map in tests. */
export interface SnapshotStore {
  /** The object at `key`, or null when there is none. */
  get(key: string): Promise<SnapshotObject | null>;
  put(key: string, object: SnapshotObject): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The prefix every snapshot lives under, and the only one the distribution may read ([PUB-1]). */
export const SNAPSHOT_PREFIX = 'c';

/**
 * Browsers keep a file a minute; the distribution keeps it a day, and each publish invalidates
 * the token's path, so a new snapshot is live within the invalidation's own minute or two.
 */
export const SNAPSHOT_CACHE_CONTROL = 'public, max-age=60, s-maxage=86400';

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

const html = 'text/html; charset=utf-8';

/** Renders every file of a snapshot from the projection alone, data files first, the page last. */
export function renderSnapshot(projection: PublicProjection): SnapshotFile[] {
  assertPublicProjection(projection);
  const encode = (text: string) => new TextEncoder().encode(text);
  const file = (name: string, text: string, contentType: string): SnapshotFile => ({
    name,
    object: { body: encode(text), contentType, cacheControl: SNAPSHOT_CACHE_CONTROL },
  });
  const page = renderPlaceholderPage(projection);
  return [
    file('catalogue.json', `${JSON.stringify(projection.catalogue)}\n`, 'application/json; charset=utf-8'),
    file('index.html', page, html),
    file('', page, html),
  ];
}

/** The placeholder page: static, no script, nothing fetched from anywhere else. */
export function renderPlaceholderPage(projection: PublicProjection): string {
  assertPublicProjection(projection);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The distribution also sends `X-Robots-Tag: noindex` on every response ([PUB-2]).
    '<meta name="robots" content="noindex, nofollow">',
    // The address holds the token: never hand it to another site in a Referer header.
    '<meta name="referrer" content="no-referrer">',
    '<title>Catalogue</title>',
    '</head>',
    '<body>',
    '<main>',
    '<h1>Nothing is published here yet.</h1>',
    '<p>This catalogue is being prepared. Please check back later.</p>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
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
  /** How many files were written, and their bytes in all. */
  readonly files: number;
  readonly bytes: number;
  /** Puts every file back as it was before this write: for a failure after the write. */
  restore(): Promise<void>;
}

/** Writes a snapshot under the token's prefix ([PUB-5], [OPS-6]). */
export async function writeSnapshot(store: SnapshotStore, token: CatalogueToken, projection: PublicProjection): Promise<WrittenSnapshot> {
  const files = renderSnapshot(projection);
  const key = (name: string) => `${SNAPSHOT_PREFIX}/${token}/${name}`;
  let previous: { key: string; object: SnapshotObject | null }[];
  try {
    previous = await Promise.all(files.map(async ({ name }) => ({ key: key(name), object: await store.get(key(name)) })));
  } catch (error) {
    // Nothing is written yet, so the previous snapshot is untouched.
    throw new SnapshotWriteError('Reading the previous snapshot failed, so nothing was written.', { cause: error, restored: true });
  }
  const written: string[] = [];

  const restore = async () => {
    // Put back only what this write touched, in reverse, so the page goes back first. A key
    // counts as touched from the moment its write starts: a write whose answer was lost may
    // still have landed.
    for (const { key: touched, object } of previous.filter(({ key: k }) => written.includes(k)).reverse()) {
      if (object === null) await store.delete(touched);
      else await store.put(touched, object);
    }
  };

  try {
    for (const { name, object } of files) {
      written.push(key(name));
      await store.put(key(name), object);
    }
  } catch (error) {
    const restored = await restore().then(
      () => true,
      () => false,
    );
    throw new SnapshotWriteError('Writing the snapshot failed.', { cause: error, restored });
  }
  return { files: files.length, bytes: files.reduce((sum, { object }) => sum + object.body.byteLength, 0), restore };
}
