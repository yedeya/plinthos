/**
 * What signing out does on the device ([SYNC-9]). The queue is the one store that outlives a
 * session, so logout is the step that takes it, and the service worker's caches, off the device:
 *
 * 1. With no network, nothing happens: the server could not end the session, so the device keeps
 *    everything and the admin is told to sign out once online.
 * 2. With mutations still queued, the admin is told how many are not yet synced, and asked to
 *    confirm. Declining keeps everything and stays signed in.
 * 3. Then the queue is emptied and every cache of the admin's origin deleted, and only then is the
 *    logout sent, which ends the session on the server ([AUTH-9]).
 */
import type { OfflineQueue } from './queue';

export interface SignOutDevice {
  /** Opens the queue, or null when the browser offers no IndexedDB. */
  openQueue(): Promise<OfflineQueue | null>;
  readonly caches: CacheStorage | undefined;
  online(): boolean;
  confirm(message: string): boolean;
  alert(message: string): void;
}

/** The warning logout shows when the queue is not empty. */
export function unsyncedWarning(pending: number): string {
  const changes = pending === 1 ? '1 change has' : `${pending} changes have`;
  return `${changes} not been synced yet. Signing out deletes ${pending === 1 ? 'it' : 'them'} from this device. Sign out anyway?`;
}

/** Deletes every cache the service worker holds. */
export async function clearCaches(caches: CacheStorage | undefined): Promise<void> {
  if (caches === undefined) return;
  for (const name of await caches.keys()) await caches.delete(name);
}

/**
 * Runs logout's device steps, and answers whether the logout may be sent: true once the queue
 * and the caches are gone, false when the admin declined or there is no network.
 */
export async function prepareSignOut(device: SignOutDevice): Promise<boolean> {
  if (!device.online()) {
    device.alert('Signing out needs a network, so the server can end the session. Nothing was changed on this device.');
    return false;
  }
  const queue = await device.openQueue();
  try {
    const pending = queue === null ? 0 : await queue.count();
    if (pending > 0 && !device.confirm(unsyncedWarning(pending))) return false;
    await queue?.clear();
  } finally {
    queue?.close();
  }
  await clearCaches(device.caches);
  return true;
}
