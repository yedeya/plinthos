import { gzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { deleteQueue, openQueue } from '../../../src/app/_offline/queue';
import { checkSetIndex, deleteSetIndex, readIndexMeta, SET_INDEX_DATABASE } from '../../../src/app/_offline/set-index';
import { indexUndeletedNotice, prepareSignOut, undeletedNotice, unfinishedNotice, unopenedWarning, unsyncedWarning, type SignOutDevice } from '../../../src/app/_offline/sign-out';

/**
 * `[SYNC-9]`: logout warns about unsynced changes, then clears the queue, the set index
 * (`[CAT-10]`) and every cache the service worker holds. `docs/qa/stack.md`'s `## Data isolation` holds this file: the queue is the
 * one store that outlives a session, and logout is what takes it off the device.
 */

function fakeCaches(names: string[]): CacheStorage & { readonly names: Set<string> } {
  const set = new Set(names);
  return {
    names: set,
    keys: async () => [...set],
    delete: async (name: string) => set.delete(name),
    has: async (name: string) => set.has(name),
    open: async () => {
      throw new Error('not used');
    },
    match: async () => undefined,
  } as unknown as CacheStorage & { readonly names: Set<string> };
}

async function device(pending: number, answers: { online?: boolean; confirm?: boolean } = {}) {
  const factory = new IDBFactory();
  const queue = await openQueue(factory);
  for (let index = 0; index < pending; index++) await queue.enqueue({ name: 'test.change', input: { n: index, note: 'made-up private note' } });
  queue.close();
  await seedIndex(factory);
  const caches = fakeCaches(['plinthos-shell-v1', 'plinthos-shell-v0', 'some-other-cache']);
  const asked: string[] = [];
  const told: string[] = [];
  const signOut: SignOutDevice = {
    openQueue: () => openQueue(factory),
    deleteQueue: () => deleteQueue(factory),
    deleteSetIndex: () => deleteSetIndex(factory),
    caches,
    online: () => answers.online ?? true,
    confirm: (message) => {
      asked.push(message);
      return answers.confirm ?? true;
    },
    alert: (message) => told.push(message),
  };
  const left = async () => {
    const reopened = await openQueue(factory);
    try {
      return await reopened.count();
    } finally {
      reopened.close();
    }
  };
  const indexLeft = async () => (await readIndexMeta(factory)) !== null;
  return { factory, signOut, caches, asked, told, left, indexLeft };
}

/** Puts a made-up set index on the device, as the admin's check stores one. */
async function seedIndex(factory: IDBFactory): Promise<void> {
  const body = gzipSync(JSON.stringify({ format: 1, builtAt: '2026-10-26T08:00:00.000Z', sources: { sets: null, themes: null, minifigs: null }, themes: [[1, 'Made-up theme', null]], sets: [['99901-1', 'Made-up set', 1, 2001, 10]], minifigs: [['fig-990001', 'Made-up figure', 3]] }));
  const answer = new Response(new Uint8Array(body), { headers: { etag: `"${'c'.repeat(64)}"`, 'content-type': 'application/gzip' } });
  if ((await checkSetIndex({ factory, fetch: (async () => answer) as unknown as typeof fetch })) !== 'updated') throw new Error('the made-up index was not stored');
}

/** Holds a database open, as another tab that never closes on a version change does, which blocks its deletion. */
function holdOpen(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const opening = factory.open(name);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

/** How a browser fails to open an IndexedDB database it has: Safari's connection errors, say. */
async function failedOpen(): Promise<never> {
  throw new DOMException('made-up connection failure', 'UnknownError');
}

describe('signing out on the device', () => {
  it('[SYNC-9] says how many changes are not yet synced, and once confirmed clears the queue and every cache', async () => {
    const { signOut, caches, asked, left } = await device(3);
    expect(await prepareSignOut(signOut)).toBe(true);
    expect(asked).toEqual([unsyncedWarning(3)]);
    expect(asked[0]).toMatch(/^3 changes have not been synced yet\./);
    expect(await left()).toBe(0);
    expect([...caches.names]).toEqual([]);
  });

  it('[SYNC-9] names a single change in the singular', () => {
    expect(unsyncedWarning(1)).toMatch(/^1 change has not been synced yet\..* deletes it /);
  });

  it('[SYNC-9] keeps the queue and the caches, and does not sign out, when the admin declines', async () => {
    const { signOut, caches, left, indexLeft } = await device(2, { confirm: false });
    expect(await prepareSignOut(signOut)).toBe(false);
    expect(await left()).toBe(2);
    expect(await indexLeft()).toBe(true);
    expect(caches.names.size).toBe(3);
  });

  it('[SYNC-9] asks nothing with an empty queue, and still clears every cache', async () => {
    const { signOut, caches, asked } = await device(0);
    expect(await prepareSignOut(signOut)).toBe(true);
    expect(asked).toEqual([]);
    expect(caches.names.size).toBe(0);
  });

  it('[SYNC-9] changes nothing without a network, since the server could not end the session', async () => {
    const { signOut, caches, told, asked, left } = await device(1, { online: false });
    expect(await prepareSignOut(signOut)).toBe(false);
    expect(told).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(await left()).toBe(1);
    expect(caches.names.size).toBe(3);
  });

  it('[SYNC-9] clears the caches in a browser with no IndexedDB', async () => {
    const { signOut, caches } = await device(0);
    expect(await prepareSignOut({ ...signOut, openQueue: async () => null })).toBe(true);
    expect(caches.names.size).toBe(0);
  });

  it('[SYNC-9] warns when the queue could not be opened, and once confirmed deletes it before signing out', async () => {
    const { signOut, caches, asked, left } = await device(2);
    expect(await prepareSignOut({ ...signOut, openQueue: failedOpen })).toBe(true);
    expect(asked).toEqual([unopenedWarning()]);
    expect(await left()).toBe(0);
    expect(caches.names.size).toBe(0);
  });

  it('[SYNC-9] keeps the queue and the caches, and does not sign out, when the admin declines an unopened queue\'s deletion', async () => {
    const { signOut, caches, left } = await device(2, { confirm: false });
    expect(await prepareSignOut({ ...signOut, openQueue: failedOpen })).toBe(false);
    expect(await left()).toBe(2);
    expect(caches.names.size).toBe(3);
  });

  it('[SYNC-9] takes an open that never settles for a failed one, rather than doing nothing', async () => {
    const { signOut, caches, asked, left } = await device(1);
    const stuck = { ...signOut, openQueue: () => new Promise<never>(() => undefined) };
    expect(await prepareSignOut(stuck, { timeoutMs: 20 })).toBe(true);
    expect(asked).toEqual([unopenedWarning()]);
    expect(await left()).toBe(0);
    expect(caches.names.size).toBe(0);
  });

  it('[SYNC-9] refuses to sign out, and keeps the caches, when the queue can be neither opened nor deleted', async () => {
    const { factory, signOut, caches, asked, told } = await device(1);
    // A tab that holds the database open and never closes on a version change blocks its deletion.
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open('plinthos-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      expect(await prepareSignOut({ ...signOut, openQueue: failedOpen }, { timeoutMs: 20 })).toBe(false);
      expect(asked).toEqual([unopenedWarning()]);
      expect(told).toEqual([undeletedNotice()]);
      expect(caches.names.size).toBe(3);
    } finally {
      holder.close();
    }
  });

  it('[SYNC-9] refuses to sign out, and keeps the queue and the caches, when deleting an unopened queue fails', async () => {
    const { signOut, caches, asked, told, left } = await device(1);
    const undeletable = {
      ...signOut,
      openQueue: failedOpen,
      deleteQueue: async () => {
        throw new DOMException('made-up deletion failure', 'UnknownError');
      },
    };
    expect(await prepareSignOut(undeletable)).toBe(false);
    expect(asked).toEqual([unopenedWarning()]);
    expect(told).toEqual([undeletedNotice()]);
    expect(await left()).toBe(1);
    expect(caches.names.size).toBe(3);
  });
});

describe('the set index on signing out', () => {
  it('[CAT-10] [SYNC-9] deletes the set index with the queue, before the caches and the logout', async () => {
    const { signOut, caches, left, indexLeft } = await device(1);
    expect(await indexLeft()).toBe(true);
    expect(await prepareSignOut(signOut)).toBe(true);
    expect(await left()).toBe(0);
    expect(await indexLeft()).toBe(false);
    expect(caches.names.size).toBe(0);
  });

  it('[CAT-10] [SYNC-9] deletes the set index too when the queue could not be opened and was deleted whole', async () => {
    const { signOut, indexLeft } = await device(1);
    expect(await prepareSignOut({ ...signOut, openQueue: failedOpen })).toBe(true);
    expect(await indexLeft()).toBe(false);
  });

  it('[CAT-10] keeps the set index when there is no network, since nothing is signed out', async () => {
    const { signOut, indexLeft } = await device(0, { online: false });
    expect(await prepareSignOut(signOut)).toBe(false);
    expect(await indexLeft()).toBe(true);
  });

  it('[CAT-10] refuses to sign out, keeps the caches and says why, when deleting the set index fails', async () => {
    const { signOut, caches, told } = await device(0);
    const undeletable = {
      ...signOut,
      deleteSetIndex: async () => {
        throw new DOMException('made-up deletion failure', 'UnknownError');
      },
    };
    expect(await prepareSignOut(undeletable)).toBe(false);
    expect(told).toEqual([indexUndeletedNotice()]);
    expect(indexUndeletedNotice()).toMatch(/set index/);
    expect(indexUndeletedNotice()).toMatch(/still signed in/);
    expect(caches.names.size).toBe(3);
  });

  it('[CAT-10] refuses to sign out when another tab holds the set index open, rather than waiting for ever', async () => {
    const { factory, signOut, caches, told, indexLeft } = await device(0);
    const holder = await holdOpen(factory, SET_INDEX_DATABASE);
    try {
      expect(await prepareSignOut(signOut, { timeoutMs: 20 })).toBe(false);
      expect(told).toEqual([indexUndeletedNotice()]);
      expect(caches.names.size).toBe(3);
    } finally {
      holder.close();
    }
    expect(await indexLeft()).toBe(false);
  });
});

describe('a device step failing once the queue is open (#99)', () => {
  /** The queue as `openQueue` makes it, with one of its operations failing as an aborted IndexedDB transaction does. */
  function failing(signOut: SignOutDevice, operation: 'count' | 'clear'): SignOutDevice {
    return {
      ...signOut,
      openQueue: async () => {
        const queue = await signOut.openQueue();
        if (queue === null) throw new Error('the made-up device has a queue');
        return {
          ...queue,
          [operation]: async () => {
            throw new DOMException('made-up transaction failure', 'AbortError');
          },
        };
      },
    };
  }

  function failingCaches(caches: CacheStorage, operation: 'keys' | 'delete'): CacheStorage {
    return new Proxy(caches, {
      get: (target, property, receiver) =>
        property === operation
          ? async () => {
              throw new DOMException('made-up Cache Storage failure', 'UnknownError');
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
  }

  it('[SYNC-9] refuses to sign out, says so and keeps the caches, when counting the queue fails', async () => {
    const { signOut, caches, asked, told, left } = await device(2);
    expect(await prepareSignOut(failing(signOut, 'count'))).toBe(false);
    expect(asked).toEqual([]);
    expect(told).toEqual([unfinishedNotice()]);
    expect(await left()).toBe(2);
    expect(caches.names.size).toBe(3);
  });

  it('[SYNC-9] refuses to sign out, says so and keeps the caches, when emptying the queue fails after the admin confirmed', async () => {
    const { signOut, caches, asked, told, left } = await device(2);
    expect(await prepareSignOut(failing(signOut, 'clear'))).toBe(false);
    expect(asked).toEqual([unsyncedWarning(2)]);
    expect(told).toEqual([unfinishedNotice()]);
    expect(await left()).toBe(2);
    expect(caches.names.size).toBe(3);
  });

  it('[SYNC-9] refuses to sign out, and says so, when listing the caches fails', async () => {
    const { signOut, caches, told } = await device(1);
    expect(await prepareSignOut({ ...signOut, caches: failingCaches(caches, 'keys') })).toBe(false);
    expect(told).toEqual([unfinishedNotice()]);
  });

  it('[SYNC-9] refuses to sign out, and says so, when deleting a cache fails after an unopened queue was deleted', async () => {
    const { signOut, caches, asked, told, left } = await device(1);
    expect(await prepareSignOut({ ...signOut, openQueue: failedOpen, caches: failingCaches(caches, 'delete') })).toBe(false);
    expect(asked).toEqual([unopenedWarning()]);
    expect(told).toEqual([unfinishedNotice()]);
    expect(await left()).toBe(0);
  });

  it('says that sign-out did not finish, that the admin is still signed in, and what to do', () => {
    expect(unfinishedNotice()).toMatch(/did not finish/);
    expect(unfinishedNotice()).toMatch(/still signed in/);
    expect(unfinishedNotice()).toMatch(/reload this page, then sign out again/i);
  });
});
