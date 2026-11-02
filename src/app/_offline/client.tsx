'use client';
/**
 * The browser half of offline entry (brief #6, decision 2): registering the service worker, the
 * queue's panel on `/admin` and `/offline`, and the sign-out button that clears the device.
 *
 * Nothing here reads a cookie or renders a server record: the panel shows only what the device's
 * own queue holds, so the same component serves the data-free shell ([SYNC-5]).
 */
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { DEFAULT_LONGEST_EDGE, LONGEST_EDGE_STORAGE_KEY, preparePhoto, queuePhoto } from './photos';
import { openQueue, type OfflineQueue, type QueuedEntry } from './queue';
import { replayOnce, type ReplayStatus } from './replay';
import { LOGIN_PATH, WORKER_PATH } from './shell';
import { prepareSignOut } from './sign-out';

/** The event `PhotoCapture` sends when it queued something, which the queue's panel syncs on. */
export const QUEUE_CHANGED = 'plinthos:queue-changed';

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
    window.addEventListener(QUEUE_CHANGED, online);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener(QUEUE_CHANGED, online);
    };
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

/** The longest edge to resize to: the one given, remembered for the offline shell, or the one last remembered. */
function longestEdgeFor(given: number | undefined): number {
  try {
    if (given !== undefined) {
      window.localStorage.setItem(LONGEST_EDGE_STORAGE_KEY, String(given));
      return given;
    }
    const remembered = Number(window.localStorage.getItem(LONGEST_EDGE_STORAGE_KEY));
    return Number.isSafeInteger(remembered) && remembered > 0 ? remembered : DEFAULT_LONGEST_EDGE;
  } catch {
    return given ?? DEFAULT_LONGEST_EDGE;
  }
}

/**
 * Takes or picks a photo, resizes and re-compresses it on the phone ([PHOTO-1]) and queues it,
 * then syncs if there is a network (#22). It works offline: the photo waits in the queue with
 * its bytes until the server has applied it. `/admin` passes the deployment's longest edge;
 * the offline shell uses the one `/admin` last passed.
 */
export function PhotoCapture({ longestEdge }: { readonly longestEdge?: number }) {
  const [message, setMessage] = useState('');
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    void (async () => {
      const queue = await deviceQueue();
      if (queue === null) {
        setMessage('This browser keeps no offline queue, so photos cannot be added here.');
        return;
      }
      try {
        const edge = longestEdgeFor(longestEdge);
        for (const file of files) await queuePhoto(queue, await preparePhoto(file, edge));
        setMessage(`${files.length} ${files.length === 1 ? 'photo is' : 'photos are'} queued on this device.`);
      } catch {
        setMessage('The photo could not be read on this device. Try another one.');
      } finally {
        queue.close();
      }
      window.dispatchEvent(new Event(QUEUE_CHANGED));
    })();
  };
  return (
    <section aria-label="Add photos">
      <label>
        Add photos <input type="file" accept="image/*" capture="environment" multiple onChange={onChange} />
      </label>
      {message === '' ? null : <p role="status">{message}</p>}
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
