/**
 * `setIndexFile` (brief #252, Issue A, [CAT-9]): the admin's read of the current set index, from
 * an in-memory store holding what a build wrote.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueAdminContext, type AdminContext } from '../../../../src/server/auth/admin-context';
import { buildSetIndex } from '../../../../src/server/catalogue/set-index/build';
import { matchesVersion, setIndexFileFor } from '../../../../src/server/catalogue/set-index/file';
import { CURRENT_KEY, versionKey } from '../../../../src/server/catalogue/set-index/format';
import { clock, memoryStore, rebrickable } from './fakes';

const admin = () => issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });

async function built() {
  const store = memoryStore();
  const time = clock();
  const outcome = await buildSetIndex({ store: store.store, fetch: rebrickable().fetch, now: time.now, sleep: time.sleep });
  if (outcome.status !== 'built') throw new Error('the made-up build failed');
  const reads: string[] = [];
  const get = store.store.get.bind(store.store);
  store.store.get = async (key) => {
    reads.push(key);
    return get(key);
  };
  return { store, version: outcome.version, reads };
}

describe('setIndexFile', () => {
  it('[CAT-9] answers the current index, gzipped as it is stored, with its version', async () => {
    const { store, version } = await built();
    const answer = await setIndexFileFor(() => store.store)(admin(), {});
    expect(answer).toEqual({ status: 'ok', version, body: store.objects.get(versionKey(version)) });
  });

  it('[CAT-9] answers not-modified to an If-None-Match that names the current version, without reading the index', async () => {
    const { store, version, reads } = await built();
    for (const ifNoneMatch of [`"${version}"`, `W/"${version}"`, `"${'0'.repeat(64)}", "${version}"`, '*']) {
      reads.length = 0;
      expect(await setIndexFileFor(() => store.store)(admin(), { ifNoneMatch })).toEqual({ status: 'not-modified', version });
      expect(reads).toEqual([CURRENT_KEY]);
    }
    expect(await setIndexFileFor(() => store.store)(admin(), { ifNoneMatch: `"${'0'.repeat(64)}"` })).toMatchObject({ status: 'ok', version });
  });

  it('[CAT-9] answers missing while no index has been built, or when the pointer names a file that is gone', async () => {
    const empty = memoryStore();
    expect(await setIndexFileFor(() => empty.store)(admin(), { ifNoneMatch: '*' })).toEqual({ status: 'missing' });
    const { store, version } = await built();
    store.objects.delete(versionKey(version));
    expect(await setIndexFileFor(() => store.store)(admin(), {})).toEqual({ status: 'missing' });
  });

  it('refuses a context the admin check did not issue, before it reads anything', async () => {
    const { store, reads } = await built();
    await expect(setIndexFileFor(() => store.store)({ sessionKey: 'forged', requestId: 'forged' } as unknown as AdminContext, {})).rejects.toThrow();
    expect(reads).toEqual([]);
  });
});

describe('matchesVersion', () => {
  it('[CAT-9] reads a strong or weak tag, a list and the wildcard, and nothing else', () => {
    expect(matchesVersion(null, 'abc')).toBe(false);
    expect(matchesVersion('', 'abc')).toBe(false);
    expect(matchesVersion('"abc"', 'abc')).toBe(true);
    expect(matchesVersion('W/"abc"', 'abc')).toBe(true);
    expect(matchesVersion('"x" , "abc"', 'abc')).toBe(true);
    expect(matchesVersion('*', 'abc')).toBe(true);
    expect(matchesVersion('abc', 'abc')).toBe(false);
    expect(matchesVersion('"abcd"', 'abc')).toBe(false);
  });
});
