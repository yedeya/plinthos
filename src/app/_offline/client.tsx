'use client';
/**
 * The browser half of offline entry (brief #6, decision 2): registering the service worker, the
 * queue's panel on `/admin` and `/offline`, and the sign-out button that clears the device.
 *
 * Nothing here reads a cookie or renders a server record: the panel shows only what the device's
 * own queue holds, so the same component serves the data-free shell ([SYNC-5]).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { openQueue, type OfflineQueue, type QueuedEntry } from './queue';
import { replayOnce, type ReplayStatus } from './replay';
import { LOGIN_PATH, WORKER_PATH } from './shell';
import { prepareSignOut } from './sign-out';

/** The device's queue, or null when the browser offers no IndexedDB. */
export async function deviceQueue(): Promise<OfflineQueue | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    return await openQueue(indexedDB);
  } catch {
    return null;
  }
}

/** Registers the service worker, on every page of the admin's origin. */
export function ServiceWorkerRegistration(): null {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(WORKER_PATH, { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
  }, []);
  return null;
}

const STATUS_TEXT: Record<ReplayStatus | 'loading', string> = {
  loading: 'Checking the queue on this device…',
  synced: 'Every change on this device is synced.',
  held: 'A change was not applied. Retry it or discard it before the rest can sync.',
  retrying: 'A change failed on the server. It is tried again, a few times, the next times the admin opens or the network returns.',
  'signed-out': 'Your session has ended. Sign in, and the queue syncs.',
  offline: 'No network: changes stay queued on this device and sync when it returns.',
  error: 'The queue could not sync just now. It will try again when the admin is opened.',
};

function describeHold(entry: QueuedEntry): string {
  const held = entry.held;
  if (held === undefined) return '';
  switch (held.outcome) {
    case 'conflict':
      return held.reason === 'version' ? 'It conflicts: the record changed on the server since.' : 'It conflicts with a change already applied under the same id.';
    case 'invalid':
      return `The server refused it as invalid${held.issues.length > 0 ? `: ${held.issues.join('; ')}` : '.'}`;
    case 'failed':
      return `It failed on the server${held.requestId === '' ? '.' : ` (request ${held.requestId}).`}`;
  }
}

/**
 * How many mutations are waiting, and each held one with retry and discard ([SYNC-8]). It
 * replays when it opens and whenever the network returns ([SYNC-7]), asks the browser to keep the
 * queue's storage, and sends the admin to the login when the session has ended.
 */
export function QueuePanel() {
  const [status, setStatus] = useState<ReplayStatus | 'loading'>('loading');
  const [entries, setEntries] = useState<QueuedEntry[]>([]);

  const withQueue = useCallback(async <T,>(use: (queue: OfflineQueue) => Promise<T>): Promise<T | undefined> => {
    const queue = await deviceQueue();
    if (queue === null) return undefined;
    try {
      return await use(queue);
    } finally {
      queue.close();
    }
  }, []);

  const sync = useCallback(async () => {
    await withQueue(async (queue) => {
      const result = navigator.onLine ? await replayOnce(queue) : { status: 'offline' as const };
      setEntries(await queue.entries());
      setStatus(result.status);
      if (result.status === 'signed-out') window.location.assign(LOGIN_PATH);
    });
  }, [withQueue]);

  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => false);
    if (navigator.onLine) {
      void navigator.serviceWorker?.ready.then((registration) => registration.active?.postMessage({ type: 'refresh-shell' })).catch(() => undefined);
    }
    void sync();
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [sync]);

  const retry = (id: string) => void withQueue((queue) => queue.release(id)).then(sync);
  const discard = (id: string) => {
    if (!window.confirm('Discard this change? It will not be synced, and this cannot be undone.')) return;
    void withQueue((queue) => queue.remove(id)).then(sync);
  };

  const held = entries.filter((entry) => entry.held !== undefined);
  return (
    <section aria-label="Offline queue">
      <p>
        {entries.length === 0 ? 'No changes are waiting to sync.' : `${entries.length} ${entries.length === 1 ? 'change is' : 'changes are'} waiting to sync.`}{' '}
        {STATUS_TEXT[status]}
      </p>
      {held.length === 0 ? null : (
        <ul>
          {held.map((entry) => (
            <li key={entry.id}>
              <code>{entry.name}</code>, queued {entry.queuedAt}. {describeHold(entry)}{' '}
              <button type="button" onClick={() => retry(entry.id)}>
                Retry
              </button>{' '}
              <button type="button" onClick={() => discard(entry.id)}>
                Discard
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The sign-out form. Without JavaScript it posts straight to `/admin/logout`; with it, it first
 * warns about unsynced changes and clears the queue and the caches ([SYNC-9]).
 */
export function SignOutButton() {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void prepareSignOut({
      openQueue: deviceQueue,
      caches: typeof caches === 'undefined' ? undefined : caches,
      online: () => navigator.onLine,
      confirm: (message) => window.confirm(message),
      alert: (message) => window.alert(message),
    }).then((proceed) => {
      if (proceed) form.submit();
    });
  };
  return (
    <form method="post" action="/admin/logout" onSubmit={onSubmit}>
      <button type="submit">Sign out</button>
    </form>
  );
}
