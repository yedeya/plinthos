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
import { deleteQueue, openQueue, type OfflineQueue, type QueuedEntry } from './queue';
import { en } from '../messages/en';
import { PHOTO_MUTATION } from '../../server/sync/limits';
import { PHOTO_NOT_ON_ITEM, UNKNOWN_ITEM, UNKNOWN_SET } from './items';
import { replayOnce, type ReplayStatus } from './replay';
import { LOGIN_PATH, WORKER_PATH } from './shell';
import { prepareSignOut } from './sign-out';

/** The event a component sends when it queued something, which the queue's sync replays on. */
export const QUEUE_CHANGED = 'plinthos:queue-changed';

/** The event the queue's sync sends after each replay, with what the queue now holds, for the status chip and the list. */
export const QUEUE_STATE = 'plinthos:queue-state';

/** What `QUEUE_STATE` carries. */
export interface QueueState {
  readonly status: ReplayStatus | 'loading';
  readonly entries: readonly QueuedEntry[];
}

/**
 * The device's queue, or null when the browser offers no IndexedDB or the queue failed to open.
 * The panel takes both for "nothing to show"; sign-out must not, so it opens the queue itself.
 */
export async function deviceQueue(): Promise<OfflineQueue | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    return await openQueue(indexedDB);
  } catch {
    return null;
  }
}

/** Runs `use` on the device's queue and closes it; undefined when there is no queue. */
export async function withDeviceQueue<T>(use: (queue: OfflineQueue) => Promise<T>): Promise<T | undefined> {
  const queue = await deviceQueue();
  if (queue === null) return undefined;
  try {
    return await use(queue);
  } finally {
    queue.close();
  }
}

/** Tells the queue's sync, the status chip and the list that something was queued. */
export function announceQueued(): void {
  window.dispatchEvent(new Event(QUEUE_CHANGED));
}

/** Registers the service worker, on every page of the admin's origin. */
export function ServiceWorkerRegistration(): null {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(WORKER_PATH, { scope: '/', updateViaCache: 'none' }).catch(() => undefined);
  }, []);
  return null;
}

/**
 * Replays the queue when the page opens, whenever the network returns and whenever something is
 * queued ([SYNC-7]), asks the browser to keep the queue's storage, sends the admin to the login
 * when the session has ended, and announces what the queue holds after each replay.
 */
function useQueueSync(): QueueState & { readonly sync: () => Promise<void> } {
  const [status, setStatus] = useState<ReplayStatus | 'loading'>('loading');
  const [entries, setEntries] = useState<QueuedEntry[]>([]);

  const sync = useCallback(async () => {
    await withDeviceQueue(async (queue) => {
      const result = navigator.onLine ? await replayOnce(queue) : { status: 'offline' as const };
      const now = await queue.entries();
      setEntries(now);
      setStatus(result.status);
      window.dispatchEvent(new CustomEvent<QueueState>(QUEUE_STATE, { detail: { status: result.status, entries: now } }));
      if (result.status === 'signed-out') window.location.assign(LOGIN_PATH);
    });
  }, []);

  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => false);
    if (navigator.onLine) {
      void navigator.serviceWorker?.ready.then((registration) => registration.active?.postMessage({ type: 'refresh-shell' })).catch(() => undefined);
    }
    void sync();
    const again = () => void sync();
    window.addEventListener('online', again);
    window.addEventListener(QUEUE_CHANGED, again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener(QUEUE_CHANGED, again);
    };
  }, [sync]);

  return { status, entries, sync };
}

/** The queue's sync without anything to show, for a page that has no queue panel, such as the entry form's. */
export function QueueSync(): null {
  useQueueSync();
  return null;
}

/**
 * What the queue holds, kept current from the sync's announcements, from the queue itself when
 * the page opens and whenever something is queued. For the status chip and the item list, which
 * show the queue but never replay it.
 */
export function useQueueState(): QueueState {
  const [state, setState] = useState<QueueState>({ status: 'loading', entries: [] });
  useEffect(() => {
    let live = true;
    const read = () =>
      void withDeviceQueue((queue) => queue.entries()).then((entries) => {
        if (live && entries !== undefined) setState((before) => ({ status: before.status, entries }));
      });
    const announced = (event: Event) => setState((event as CustomEvent<QueueState>).detail);
    read();
    window.addEventListener(QUEUE_STATE, announced);
    window.addEventListener(QUEUE_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(QUEUE_STATE, announced);
      window.removeEventListener(QUEUE_CHANGED, read);
    };
  }, []);
  return state;
}

/** Whether the device says it has a network, kept current. */
export function useOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Where the status chip's "needs you" sends the admin: the held list on `/admin`. */
export const HELD_ANCHOR = 'held';

/**
 * The header's status chip ([SYNC-8], `docs/design/ui.md`): online or offline, how many changes
 * are still to sync, and how many are held for the admin, which links to the held list.
 */
export function StatusChip() {
  const online = useOnline();
  const { entries } = useQueueState();
  const held = entries.filter((entry) => entry.held !== undefined).length;
  const pending = entries.length;
  const m = en.status;
  return (
    <span className="status" role="status" aria-label={m.label}>
      {online === null ? (
        <span className="chip">{m.checking}</span>
      ) : online ? (
        pending === 0 ? (
          <span className="chip chip--ok">
            <span className="chip__dot" aria-hidden="true" />
            {m.online}
          </span>
        ) : null
      ) : (
        <span className="chip chip--warn">
          <span className="chip__dot" aria-hidden="true" />
          {m.offline}
        </span>
      )}
      {pending - held > 0 ? (
        <span className="chip chip--warn">
          <span className="chip__dot" aria-hidden="true" />
          {m.toSync(pending - held)}
        </span>
      ) : null}
      {held > 0 ? (
        <a className="chip chip--danger" href={`/admin#${HELD_ANCHOR}`}>
          {m.needsYou(held)}
        </a>
      ) : null}
    </span>
  );
}

function describeHold(entry: QueuedEntry): string {
  const held = entry.held;
  if (held === undefined) return '';
  const m = en.queue.held;
  switch (held.outcome) {
    case 'conflict':
      return held.reason === 'version' ? m.versionConflict : m.payloadConflict;
    case 'invalid':
      if (held.code === UNKNOWN_SET) return m.unknownSet;
      if (held.code === UNKNOWN_ITEM) return m.unknownItem;
      if (held.code === PHOTO_NOT_ON_ITEM) return m.photoNotOnItem;
      return m.invalid(held.issues);
    case 'failed':
      return m.failed(held.requestId);
  }
}

/** What a held entry is about: the set it saves, when it saves one. */
function heldSubject(entry: QueuedEntry): string {
  const input = entry.input as { setNum?: unknown } | null;
  return typeof input?.setNum === 'string' ? input.setNum : '';
}

/** What the admin is asked before a discard: what goes with the held mutation, named by its set. */
export function discardQuestion(entries: readonly QueuedEntry[], id: string): string {
  const held = entries.find((entry) => entry.id === id);
  const group = held === undefined ? [] : entries.filter((entry) => entry.group === held.group);
  if (group.length <= 1) return en.queue.confirmDiscard;
  const subject = group.map(heldSubject).find((setNum) => setNum !== '') ?? null;
  const photos = group.filter((entry) => entry.name === PHOTO_MUTATION).length;
  const others = group.length - photos - (subject === null ? 0 : 1);
  return en.queue.confirmDiscardGroup(subject, photos, others);
}

/**
 * How many mutations are waiting, and each held one with retry and discard ([SYNC-8]): the held
 * list `/admin` shows above the items. It replays the queue as `useQueueSync` says.
 */
export function QueuePanel() {
  const { status, entries, sync } = useQueueSync();

  const retry = (id: string) => void withDeviceQueue((queue) => queue.release(id)).then(sync);
  // A discard takes the held mutation's whole group: an item's photos and their order depend on
  // its saveItem, so none of them may apply once the owner has said the item won't sync.
  const discard = (id: string) => {
    if (!window.confirm(discardQuestion(entries, id))) return;
    void withDeviceQueue((queue) => queue.discardGroup(id)).then(sync);
  };

  const held = entries.filter((entry) => entry.held !== undefined);
  return (
    <section className="section" aria-label={en.queue.label} id={HELD_ANCHOR}>
      <p className="muted">
        {entries.length === 0 ? en.queue.empty : en.queue.waiting(entries.length)} {en.queue.state[status]}
      </p>
      {held.length === 0 ? null : (
        <>
          <h2>{en.queue.heldTitle}</h2>
          <ul className="held">
            {held.map((entry) => (
              <li key={entry.id} className="card">
                <span>
                  <strong>{en.queue.mutation[entry.name] ?? entry.name}</strong> {heldSubject(entry)} <code>{entry.name}</code>
                </span>
                <span className="muted">{en.queue.queuedAt(entry.queuedAt)}</span>
                <span>{describeHold(entry)}</span>
                <span className="held__actions">
                  <button type="button" className="button" onClick={() => retry(entry.id)}>
                    {en.queue.retry}
                  </button>
                  <button type="button" className="button button--danger" onClick={() => discard(entry.id)}>
                    {en.queue.discard}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The longest edge to resize to: the one given, remembered for the offline shell, or the one last remembered. */
export function longestEdgeFor(given: number | undefined): number {
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
        setMessage(en.form.photos.noQueue);
        return;
      }
      try {
        const edge = longestEdgeFor(longestEdge);
        for (const file of files) await queuePhoto(queue, await preparePhoto(file, edge));
        setMessage(en.photosPage.captureQueued(files.length));
      } catch {
        setMessage(en.form.photos.unreadable);
      } finally {
        queue.close();
      }
      announceQueued();
    })();
  };
  return (
    <section className="section" aria-label={en.photosPage.capture}>
      <label className="button">
        {en.photosPage.capture} <input className="visually-hidden" type="file" accept="image/*" capture="environment" multiple onChange={onChange} />
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
      openQueue: async () => (typeof indexedDB === 'undefined' ? null : openQueue(indexedDB)),
      deleteQueue: () => deleteQueue(indexedDB),
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
      <button type="submit" className="button button--link">
        {en.signOut.button}
      </button>
    </form>
  );
}
