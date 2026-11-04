/**
 * `setIndexFile` (brief #252, Issue A, [CAT-9]): the admin's read of the current set index, which
 * `GET /admin/api/sets/index` answers. An `adminOperation`, so it refuses any context the session
 * check did not issue before it reads anything.
 *
 * It reads the pointer first, and answers `not-modified` when the caller's `If-None-Match` names
 * the current version, without reading the index. Otherwise it answers the index's bytes as they
 * are stored, gzipped, with its version, or `missing` while no index has been built. The index
 * holds only Rebrickable's public facts ([CAT-6]); it is behind the admin so that nothing public
 * serves it ([CAT-8]).
 */
import { z } from 'zod';
import { adminOperation } from '../../auth/admin-context';
import { readPointer, type SetIndexReadStore } from './format';
import { linkedSetIndexStore, READER_LINK } from './s3';

export const SetIndexFileInput = z.strictObject({ ifNoneMatch: z.string().max(4096).nullable().optional() });

export type SetIndexFileAnswer = { readonly status: 'missing' } | { readonly status: 'not-modified'; readonly version: string } | { readonly status: 'ok'; readonly version: string; readonly body: Uint8Array };

/** Whether an `If-None-Match` header names the version: a strong or weak tag, one of a list, or `*`. */
export function matchesVersion(header: string | null | undefined, version: string): boolean {
  if (header === null || header === undefined) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${version}"`);
}

/** The operation over a store; the deployed one is `setIndexFile` below. */
export function setIndexFileFor(store: () => SetIndexReadStore) {
  return adminOperation(SetIndexFileInput, async (_admin, input): Promise<SetIndexFileAnswer> => {
    const reader = store();
    const pointer = await readPointer(reader);
    if (pointer === null) return { status: 'missing' };
    if (matchesVersion(input.ifNoneMatch, pointer.version)) return { status: 'not-modified', version: pointer.version };
    const body = await reader.get(pointer.key);
    return body === null ? { status: 'missing' } : { status: 'ok', version: pointer.version, body };
  });
}

const reader = linkedSetIndexStore(READER_LINK);

/** The admin's read, through its own link to the index's prefix. */
export const setIndexFile = setIndexFileFor(() => reader);
