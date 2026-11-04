/**
 * The set index's shape and where it is kept (brief #252, Issue A, [CAT-6], [CAT-7]), shared by
 * the builder (`./build.ts`) and the admin's read (`./file.ts`).
 *
 * Everything lives under `set-index/` of the private photo bucket, which nothing serves
 * (`infra/set-index.ts`):
 *
 * - `set-index/<version>.json.gz`: one index, gzipped JSON, named by its version, the SHA-256 of
 *   its rows (`themes`, `sets` and `minifigs`, with the format). Only the rows: a build whose rows
 *   are unchanged has the same version, so it writes nothing new, and the stored index keeps the
 *   build time and the files' dates of the build that wrote it.
 * - `set-index/current.json`: the pointer, which names the current version and its counts, so the
 *   builder's check against the previous index ([CAT-7]) reads this small file alone. The builder
 *   writes it only after the index it names, so the admin never reads a pointer to nothing.
 * - `set-index/attempt.json`: the time of the last attempt that went on to fetch ([CAT-8]).
 *
 * The previous version is kept until the next build replaces it, and older ones are deleted.
 *
 * Each row is an array, to keep the file small (about 640 KB gzipped for 46,000 rows, brief #252,
 * §1). A set is `[number, name, theme id, year, parts]`, with a sixth element only when its stock
 * image is not `<number>.jpg` under `SET_IMAGE_BASE`: the path under it, the full address when the
 * image is elsewhere, or `''` when Rebrickable has none. A minifigure is `[number, name, parts]`; its
 * image is always `<number>.jpg` under the same base. A theme is `[id, name, parent id or null]`.
 */
import { z } from 'zod';
import { SET_INDEX_FORMAT, type MinifigRow, type SetRow, type SourceName, type ThemeRow } from './rows';

export { SET_IMAGE_BASE, SET_INDEX_FORMAT, type MinifigRow, type SetRow, type SourceName, type ThemeRow } from './rows';

/** The prefix of the photo bucket the index is kept under, which nothing serves ([CAT-8]). */
export const SET_INDEX_PREFIX = 'set-index/';
/** The pointer to the current version. */
export const CURRENT_KEY = `${SET_INDEX_PREFIX}current.json`;
/** The marker of the last attempt that fetched ([CAT-8]). */
export const ATTEMPT_KEY = `${SET_INDEX_PREFIX}attempt.json`;

/** A version: the SHA-256 of the index's rows, in hex. */
export const Version = z.string().regex(/^[0-9a-f]{64}$/);

/** The key one version is stored under. */
export function versionKey(version: string): string {
  return `${SET_INDEX_PREFIX}${Version.parse(version)}.json.gz`;
}

/** Whether a key under the prefix is a stored version. */
export function isVersionKey(key: string): boolean {
  return /^set-index\/[0-9a-f]{64}\.json\.gz$/.test(key);
}

export interface SetIndex {
  readonly format: typeof SET_INDEX_FORMAT;
  /** When the build that wrote it ran, as an ISO 8601 instant. */
  readonly builtAt: string;
  /** Each source file's `Last-Modified`, as Rebrickable sent it, or null when it sent none. */
  readonly sources: Readonly<Record<SourceName, string | null>>;
  readonly themes: readonly ThemeRow[];
  readonly sets: readonly SetRow[];
  readonly minifigs: readonly MinifigRow[];
}

const Count = z.number().int().nonnegative();

/** The pointer, as the builder writes it and both readers check it. */
export const Pointer = z.strictObject({
  format: z.literal(SET_INDEX_FORMAT),
  version: Version,
  key: z.string(),
  builtAt: z.iso.datetime(),
  counts: z.strictObject({ sets: Count, minifigs: Count, themes: Count }),
});
export type Pointer = z.infer<typeof Pointer>;

/** The attempt marker ([CAT-8]). */
export const AttemptMarker = z.strictObject({ attemptedAt: z.iso.datetime() });

/**
 * The index's prefix of the bucket, as the builder and the admin reach it (`./s3.ts`). A key the
 * bucket doesn't hold reads as null, never as a failure.
 */
export interface SetIndexStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key under the prefix. */
  list(prefix: string): Promise<string[]>;
}

/** What the admin's read needs of the store. */
export type SetIndexReadStore = Pick<SetIndexStore, 'get'>;

/** A stored pointer, checked. Throws on one that is not a pointer, or that names another version's key. */
export function parsePointer(body: Uint8Array): Pointer {
  const pointer = Pointer.parse(JSON.parse(new TextDecoder().decode(body)));
  if (pointer.key !== versionKey(pointer.version)) throw new Error('the set index’s pointer names a key other than its version’s');
  return pointer;
}

/** The current pointer, or null while no index has been built. Throws on a pointer it can't read. */
export async function readPointer(store: SetIndexReadStore): Promise<Pointer | null> {
  const body = await store.get(CURRENT_KEY);
  return body === null ? null : parsePointer(body);
}
