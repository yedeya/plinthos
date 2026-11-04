'use client';
/**
 * The browser half of offline entry (brief #6, decision 2): registering the service worker, the
 * queue's panel on `/admin` and `/offline`, and the sign-out button that clears the device.
 *
 * Nothing here reads a cookie or renders a server record: the panel shows only what the device's
 * own queue holds, so the same component serves the data-free shell ([SYNC-5]).
 */
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { DEFAULT_LONGEST_EDGE, LONGEST_EDGE_STORAGE_KEY, preparePhoto, queuePhoto } from './photos';
import { deleteQueue, openQueue, type OfflineQueue, type QueuedEntry } from './queue';
import { en } from '../messages/en';
import { PHOTO_MUTATION } from '../../server/sync/limits';
import { PHOTO_NOT_ON_ITEM, UNKNOWN_ITEM, UNKNOWN_SET } from './items';
import { abandonReplay, QUEUE_PROGRESS, replayOnce, type CatalogueOutcome, type ReplayStatus, type UploadProgress } from './replay';
import { LOGIN_PATH, WORKER_PATH } from './shell';
import { prepareSignOut } from './sign-out';

/** The event a component sends when it queued something, which the queue's sync replays on. */
export const QUEUE_CHANGED = 'plinthos:queue-changed';

/** The event the queue's sync sends after each replay, with what the queue now holds, for the status chip and the list. */
export const QUEUE_STATE = 'plinthos:queue-state';

/** The event the replay sends while it uploads photos, with `{ uploaded, total }` (`./replay.ts`, #203). */
export { QUEUE_PROGRESS, type UploadProgress };

/** What `QUEUE_STATE` carries. */
export interface QueueState {
  readonly status: ReplayStatus | 'loading';
  readonly entries: readonly QueuedEntry[];
  /** How many mutations the replay just announced applied on the server; absent before any replay. */
  readonly applied?: number;
  /** What the republish after the replay's deletes came to ([PUB-16]); absent when it deleted nothing the catalogue may show. */
  readonly catalogue?: CatalogueOutcome;
}

/**
 * Where the device keeps the last synced delete's catalogue outcome to tell (#192): this tab's
 * session storage, so that the word outlives the navigation or reload that often follows a sync
 * (the set's Delete goes back to the items, and the list reloads after a sync, [ITEM-8]).
 */
export const CATALOGUE_OUTCOME_KEY = 'plinthos:catalogue-after-sync';

/** The stored outcome to tell, or null; a browser that refuses storage keeps none. */
function storedCatalogueOutcome(): 'updated' | 'stale' | null {
  try {
    const stored = window.sessionStorage.getItem(CATALOGUE_OUTCOME_KEY);
    return stored === 'updated' || stored === 'stale' ? stored : null;
  } catch {
    return null;
  }
}

/** Keeps a sync's outcome to tell, replacing the one before; `not-published` has nothing to tell. */
function storeCatalogueOutcome(outcome: CatalogueOutcome | null): void {
  try {
    if (outcome === 'updated' || outcome === 'stale') window.sessionStorage.setItem(CATALOGUE_OUTCOME_KEY, outcome);
    else window.sessionStorage.removeItem(CATALOGUE_OUTCOME_KEY);
  } catch {
    // Without storage the word is still shown on the page that synced.
  }
}

/** The event `clearSyncedCatalogueOutcome` sends, which the header's notice hides on. */
const CATALOGUE_OUTCOME_CLEARED = 'plinthos:catalogue-outcome-cleared';

/**
 * Forgets the last synced delete's catalogue outcome and hides its notice, for a publish from this
 * tab that succeeded: the catalogue it wrote no longer shows what the sync deleted (#192).
 */
export function clearSyncedCatalogueOutcome(): void {
  storeCatalogueOutcome(null);
  window.dispatchEvent(new Event(CATALOGUE_OUTCOME_CLEARED));
}

/** How long a Save waits for its own sync before it shows the items anyway, again after each photo uploaded. */
export const SAVE_SYNC_WAIT_MS = 8_000;

/** The longest a Save waits for its own sync in all, however long its photos keep arriving (#203). */
export const SAVE_SYNC_CAP_MS = 60_000;

/**
 * Resolves when the queue's sync next announces what it did, or after `timeoutMs`. Register it
 * before announcing the change, so the sync it starts can't finish first.
 *
 * While the sync's photos are still uploading (`QUEUE_PROGRESS`), each one uploaded rearms the
 * wait for another `timeoutMs`, so a slow connection doesn't give up on a sync that is getting
 * on. Once the last is up, the sync's batch is with the server, which may take a while to store
 * the photos, so the wait runs to the cap. It never passes `capMs` from the start (#203).
 */
export function nextSync(timeoutMs: number, capMs: number = SAVE_SYNC_CAP_MS): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + Math.max(timeoutMs, capMs);
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      window.removeEventListener(QUEUE_STATE, done);
      window.removeEventListener(QUEUE_PROGRESS, progressed);
      clearTimeout(timer);
      resolve();
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(done, Math.max(0, Math.min(ms, deadline - Date.now())));
    };
    const progressed = (event: Event) => {
      const { uploaded, total } = (event as CustomEvent<UploadProgress>).detail;
      arm(uploaded >= total ? deadline - Date.now() : timeoutMs);
    };
    arm(timeoutMs);
    window.addEventListener(QUEUE_STATE, done);
    window.addEventListener(QUEUE_PROGRESS, progressed);
  });
}

/**
 * How far this tab's sync has got with its photo uploads, from `QUEUE_PROGRESS`, or null when no
 * sync is uploading: cleared when the sync announces what it did.
 */
export function useUploadProgress(): UploadProgress | null {
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  useEffect(() => {
    const progressed = (event: Event) => setProgress((event as CustomEvent<UploadProgress>).detail);
    const finished = () => setProgress(null);
    window.addEventListener(QUEUE_PROGRESS, progressed);
    window.addEventListener(QUEUE_STATE, finished);
    return () => {
      window.removeEventListener(QUEUE_PROGRESS, progressed);
      window.removeEventListener(QUEUE_STATE, finished);
    };
  }, []);
  return progress;
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

/**
 * Goes to `path` from a page whose sync may still be with the server (#169). The replay running
 * now is abandoned first, so a mutation the server applies while `path` is drawn stays queued:
 * that page lists it as not synced, its own sync is answered already applied, and the list
 * reloads ([ITEM-8], `useReloadWhenSynced`). Taken out of the queue by this page, it would show
 * nowhere until the app was reloaded.
 */
export function leaveFor(path: string): void {
  abandonReplay();
  window.location.assign(path);
}

/**
 * A link to a server-drawn admin page, such as the header's Back, from a page whose sync may still
 * be with the server (#243). Followed in this tab, it leaves as `leaveFor` does, so the page it
 * opens lists what the sync applies meanwhile ([ITEM-8]). A click the browser takes elsewhere (a
 * new tab or window, with a modifier key) or to a place on this same page (a hash link) is left
 * to the browser: this page stays, and its sync counts what it applied. Without JavaScript, or
 * before the page hydrates, it is a plain link.
 */
export function LeaveLink({ href, className, children }: { readonly href: string; readonly className?: string; readonly children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const here = new URL(document.URL);
    const there = new URL(href, here);
    if (there.origin !== here.origin) return;
    if (there.hash !== '' && there.pathname === here.pathname && there.search === here.search) return;
    event.preventDefault();
    leaveFor(there.pathname + there.search + there.hash);
  };
  return (
    <a className={className} href={href} onClick={onClick}>
      {children}
    </a>
  );
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
      const applied = 'applied' in result ? result.applied : 0;
      const catalogue = 'catalogue' in result ? result.catalogue : undefined;
      // Stored before the announcement, which may reload the page or send it elsewhere.
      if (catalogue !== undefined) storeCatalogueOutcome(catalogue);
      window.dispatchEvent(new CustomEvent<QueueState>(QUEUE_STATE, { detail: { status: result.status, entries: now, applied, ...(catalogue === undefined ? {} : { catalogue }) } }));
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

/**
 * Reloads the page when the queue's sync applies something on the server, so a server-drawn list
 * shows what just synced ([ITEM-8]). A reload's own sync applies nothing new, so it never loops.
 */
export function useReloadWhenSynced(): void {
  useEffect(() => {
    const announced = (event: Event) => {
      if (((event as CustomEvent<QueueState>).detail.applied ?? 0) > 0) window.location.reload();
    };
    window.addEventListener(QUEUE_STATE, announced);
    return () => window.removeEventListener(QUEUE_STATE, announced);
  }, []);
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

/**
 * Under the header of every admin page and the offline shell: whether the public catalogue was
 * updated after a queued `deletePhoto` or `deleteItem` synced ([PUB-16], #192), as `/admin/photos`
 * and `/admin/parts` say after their own Delete. It shows what a sync announces, and on opening
 * what the last sync stored. "Removed from the public catalogue" is shown once more on the next
 * page, so a reload or a navigation after the sync never hides it. "Press Publish" stays on every
 * page until the admin dismisses it, a later sync replaces it or a publish from this tab succeeds,
 * so a failed republish is never taken for a deleted set gone from the public site.
 */
export function SyncedCatalogueNotice() {
  const [outcome, setOutcome] = useState<'updated' | 'stale' | null>(null);
  useEffect(() => {
    const stored = storedCatalogueOutcome();
    if (stored === 'updated') storeCatalogueOutcome(null);
    setOutcome(stored);
    const announced = (event: Event) => {
      const { catalogue } = (event as CustomEvent<QueueState>).detail;
      if (catalogue !== undefined) setOutcome(catalogue === 'not-published' ? null : catalogue);
    };
    const cleared = () => setOutcome(null);
    window.addEventListener(QUEUE_STATE, announced);
    window.addEventListener(CATALOGUE_OUTCOME_CLEARED, cleared);
    return () => {
      window.removeEventListener(QUEUE_STATE, announced);
      window.removeEventListener(CATALOGUE_OUTCOME_CLEARED, cleared);
    };
  }, []);
  if (outcome === null) return null;
  const m = en.catalogueAfterDelete;
  const dismiss = () => {
    storeCatalogueOutcome(null);
    setOutcome(null);
  };
  return (
    <p className="catalogue-notice" role={outcome === 'stale' ? 'alert' : 'status'}>
      {m[outcome]}{' '}
      <button type="button" className="button button--link" onClick={dismiss}>
        {m.dismiss}
      </button>
    </p>
  );
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
  const progress = useUploadProgress();
  const held = entries.filter((entry) => entry.held !== undefined).length;
  const pending = entries.length;
  const m = en.status;
  const uploading = progress !== null && progress.uploaded < progress.total;
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
      {uploading ? (
        <span className="chip chip--warn">
          <span className="chip__dot" aria-hidden="true" />
          {m.uploading(progress.uploaded, progress.total)}
        </span>
      ) : pending - held > 0 ? (
        <span className="chip chip--warn">
          <span className="chip__dot" aria-hidden="true" />
          {m.toSync(pending - held)}
        </span>
      ) : null}
      {held > 0 ? (
        <LeaveLink className="chip chip--danger" href={`/admin#${HELD_ANCHOR}`}>
          {m.needsYou(held)}
        </LeaveLink>
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

/** What a held entry is about: the set it saves, or a non-set's own name (#202), when it saves one. */
function heldSubject(entry: QueuedEntry): string {
  const input = entry.input as { setNum?: unknown; name?: unknown } | null;
  if (typeof input?.setNum === 'string') return input.setNum;
  return typeof input?.name === 'string' ? input.name : '';
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
export function PhotoCapture({
  longestEdge,
  partsLot,
  label,
  disabled,
}: {
  readonly longestEdge?: number;
  /** Queues the photos as the parts lot's overview photos ([PARTS-5]). */
  readonly partsLot?: boolean;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
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
        for (const file of files) await queuePhoto(queue, await preparePhoto(file, edge), { partsLot: partsLot === true });
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
    <section className="section" aria-label={label ?? en.photosPage.capture}>
      <label className="button" aria-disabled={disabled === true}>
        {label ?? en.photosPage.capture}{' '}
        <input className="visually-hidden" type="file" accept="image/*" capture="environment" multiple disabled={disabled === true} onChange={onChange} />
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
