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
 *
 * A queue that is there but could not be opened, whether the open failed or never settled, may
 * still hold mutations, so it is never taken for an empty one: the admin is warned that unsynced
 * changes may be on it, and once they confirm, its database is deleted whole. When that fails
 * too, the admin is told the queue stays on the device, and signs out only if they accept that.
 */
import type { OfflineQueue } from './queue';

/** How long opening or deleting the queue may take before logout gives up on it. */
export const QUEUE_TIMEOUT_MS = 5000;

export interface SignOutDevice {
  /** Opens the queue, or null when the browser offers no IndexedDB; rejects when it could not open it. */
  openQueue(): Promise<OfflineQueue | null>;
  /** Deletes the queue's database whole, for when it could not be opened. */
  deleteQueue(): Promise<void>;
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

/** The warning logout shows when the queue could not be opened, so its count is unknown. */
export function unopenedWarning(): string {
  return 'The queue on this device could not be opened, so it may hold changes that have not been synced yet. Signing out deletes them from this device. Sign out anyway?';
}

/** The warning logout shows when the queue could be neither opened nor deleted. */
export function leftBehindWarning(): string {
  return 'The queue on this device could not be deleted either, so any changes not yet synced stay on this device and sync after you next sign in. Sign out anyway, and leave them there?';
}

/** Deletes every cache the service worker holds. */
export async function clearCaches(caches: CacheStorage | undefined): Promise<void> {
  if (caches === undefined) return;
  for (const name of await caches.keys()) await caches.delete(name);
}

/** Settles as the promise does, or rejects once `ms` have passed without it settling. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from IndexedDB within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs logout's device steps, and answers whether the logout may be sent: true once the queue
 * and the caches are gone, or the admin accepted leaving a queue that could not be deleted; false
 * when the admin declined or there is no network.
 */
export async function prepareSignOut(device: SignOutDevice, { timeoutMs = QUEUE_TIMEOUT_MS } = {}): Promise<boolean> {
  if (!device.online()) {
    device.alert('Signing out needs a network, so the server can end the session. Nothing was changed on this device.');
    return false;
  }
  const opening = device.openQueue();
  let queue: OfflineQueue | null;
  try {
    queue = await within(opening, timeoutMs);
  } catch {
    // An open that answers after all must not keep the database open against its deletion.
    void opening.then((late) => late?.close(), () => undefined);
    if (!(await deleteUnopened(device, timeoutMs))) return false;
    await clearCaches(device.caches);
    return true;
  }
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

/** Takes a queue that could not be opened off the device, after a warning; false when the admin declined. */
async function deleteUnopened(device: SignOutDevice, timeoutMs: number): Promise<boolean> {
  if (!device.confirm(unopenedWarning())) return false;
  try {
    await within(device.deleteQueue(), timeoutMs);
    return true;
  } catch {
    return device.confirm(leftBehindWarning());
  }
}
