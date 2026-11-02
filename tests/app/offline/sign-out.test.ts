import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { deleteQueue, openQueue } from '../../../src/app/_offline/queue';
import { prepareSignOut, undeletedNotice, unopenedWarning, unsyncedWarning, type SignOutDevice } from '../../../src/app/_offline/sign-out';

/**
 * `[SYNC-9]`: logout warns about unsynced changes, then clears the queue and every cache the
 * service worker holds. `docs/qa/stack.md`'s `## Data isolation` holds this file: the queue is the
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
  const caches = fakeCaches(['plinthos-shell-v1', 'plinthos-shell-v0', 'some-other-cache']);
  const asked: string[] = [];
  const told: string[] = [];
  const signOut: SignOutDevice = {
    openQueue: () => openQueue(factory),
    deleteQueue: () => deleteQueue(factory),
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
  return { factory, signOut, caches, asked, told, left };
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
    const { signOut, caches, left } = await device(2, { confirm: false });
    expect(await prepareSignOut(signOut)).toBe(false);
    expect(await left()).toBe(2);
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
