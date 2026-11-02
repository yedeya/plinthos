/**
 * The offline queue on the admin's device ([SYNC-7], [SYNC-8]): an IndexedDB store of the
 * mutations made without a network, in the order they were made, waiting to be replayed into
 * the offline-sync endpoint (`./replay.ts`, `src/app/admin/api/sync/route.ts`).
 *
 * It is the one store that deliberately outlives a session (brief #6, §1): a stretch offline can
 * outlast the 7-day idle lifetime, so an ended session keeps the queue for after the next
 * sign-in. Only two things take a mutation out of it: the server answering it as applied or
 * already applied, or the admin discarding it. Logout clears it, after a warning
 * (`./sign-out.ts`, [SYNC-9]).
 *
 * A mutation the server did not apply, a conflict, an invalid or a failed one, is *held*: it keeps
 * its place, with what the server said, and the queue does not replay past it until the admin
 * retries it or discards it, because what was queued after it may depend on it (the Owner's
 * decision on #56). A `failed` one is first retried by the replay itself, a few times with
 * backoff (`./replay.ts`, the Owner's decision on #73); it keeps its place while it waits, with
 * its `retry` state, and is held only once those attempts are spent. Nothing of the server's
 * records is stored with it: a conflict keeps its reason, never the server's current record.
 */

const DATABASE = 'plinthos-offline';
const STORE = 'mutations';
const VERSION = 1;

/**
 * A photo waiting to reach the server with its mutation (#22, #9): the resized JPEG's bytes, kept
 * here until the server answers its `registerPhoto` as applied or already applied, and the
 * quarantine key of the upload that carried them, once there is one. The replay uploads the bytes
 * when the mutation has no key, and again when the server says the upload is gone.
 */
export interface PendingUpload {
  readonly bytes: ArrayBuffer;
  readonly quarantineKey?: string;
}

/** What a caller queues: a registered mutation's name and input, as the endpoint takes them. */
export interface NewMutation {
  readonly name: string;
  readonly input: unknown;
  /** For a mutation that changes a versioned record: the version it was made against, null to create. */
  readonly baseVersion?: number | null;
  /** For a photo's `registerPhoto`: the bytes to upload first. Its key joins the input when it is sent. */
  readonly upload?: PendingUpload;
}

/** Why a held mutation was not applied, as the endpoint answered it. */
export type HeldOutcome =
  | { readonly outcome: 'conflict'; readonly reason: 'payload' | 'version' }
  | { readonly outcome: 'invalid'; readonly issues: readonly string[]; readonly code?: string }
  | { readonly outcome: 'failed'; readonly requestId: string };

/** One queued mutation, as stored. */
export interface QueuedEntry extends NewMutation {
  /** The order it was queued in, which replay keeps. */
  readonly seq: number;
  /** The client-generated UUID the endpoint keys it by ([SYNC-2]). */
  readonly id: string;
  readonly queuedAt: string;
  /** Set when the server did not apply it; cleared by a retry. */
  readonly held?: HeldOutcome & { readonly at: string };
  /** Set after it failed on the server: how often, and when the replay may send it again. */
  readonly retry?: RetryState;
}

/** A failed mutation waiting for the replay to send it again. */
export interface RetryState {
  /** How many times the server answered it as failed. */
  readonly failures: number;
  /** When it last failed, as an ISO string, by the device's clock. */
  readonly failedAt: string;
  /** How long after `failedAt` the replay waits before it sends it again. */
  readonly delayMs: number;
  /** The request id of the last failure, which the server's log names. */
  readonly requestId: string;
}

export interface OfflineQueue {
  /** Queues a mutation behind every other, with a fresh id. */
  enqueue(mutation: NewMutation): Promise<QueuedEntry>;
  /** Every queued mutation, in queue order. */
  entries(): Promise<QueuedEntry[]>;
  count(): Promise<number>;
  /** Takes one mutation out: it was applied, or the admin discarded it. */
  remove(id: string): Promise<void>;
  /** Marks one mutation as not applied, with what the server said. */
  hold(id: string, outcome: HeldOutcome): Promise<void>;
  /** Records a failure the replay will retry by itself, keeping the mutation in its place. */
  deferRetry(id: string, retry: RetryState): Promise<void>;
  /** Lifts the hold and any retry wait, so the next replay sends it again, with its attempts reset. */
  release(id: string): Promise<void>;
  /** Records the quarantine key a photo's bytes were uploaded under, or forgets it so they are uploaded again. */
  setUploadKey(id: string, quarantineKey: string | undefined): Promise<void>;
  /** Empties the queue: logout's step, after the admin confirmed ([SYNC-9]). */
  clear(): Promise<void>;
  close(): void;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('an IndexedDB request failed'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('an IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('an IndexedDB transaction was aborted'));
  });
}

/**
 * Deletes the device's queue whole: logout's way to take it off the device when it could not be
 * opened ([SYNC-9]). The deletion waits for every other connection to close, so it can be blocked.
 */
export async function deleteQueue(factory: IDBFactory = indexedDB): Promise<void> {
  await promised(factory.deleteDatabase(DATABASE));
}

/** Opens the device's queue, creating it on first use. */
export async function openQueue(factory: IDBFactory = indexedDB): Promise<OfflineQueue> {
  const opening = factory.open(DATABASE, VERSION);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
    store.createIndex('id', 'id', { unique: true });
  };
  const database = await promised(opening);
  // Another tab upgrading or deleting the database must not wait on this one.
  database.onversionchange = () => database.close();

  async function write(change: (store: IDBObjectStore) => void): Promise<void> {
    const transaction = database.transaction(STORE, 'readwrite');
    change(transaction.objectStore(STORE));
    await done(transaction);
  }

  async function update(id: string, change: (entry: QueuedEntry) => QueuedEntry): Promise<void> {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const entry = (await promised(store.index('id').get(id))) as QueuedEntry | undefined;
    if (entry !== undefined) store.put(change(entry));
    await done(transaction);
  }

  return {
    async enqueue(mutation) {
      const entry: Omit<QueuedEntry, 'seq'> = {
        id: crypto.randomUUID(),
        name: mutation.name,
        input: mutation.input,
        ...(mutation.baseVersion === undefined ? {} : { baseVersion: mutation.baseVersion }),
        ...(mutation.upload === undefined ? {} : { upload: mutation.upload }),
        queuedAt: new Date().toISOString(),
      };
      const transaction = database.transaction(STORE, 'readwrite');
      const seq = (await promised(transaction.objectStore(STORE).add(entry))) as number;
      await done(transaction);
      return { ...entry, seq };
    },
    async entries() {
      const transaction = database.transaction(STORE, 'readonly');
      return (await promised(transaction.objectStore(STORE).getAll())) as QueuedEntry[];
    },
    async count() {
      return promised(database.transaction(STORE, 'readonly').objectStore(STORE).count());
    },
    async remove(id) {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const key = await promised(store.index('id').getKey(id));
      if (key !== undefined) store.delete(key);
      await done(transaction);
    },
    hold: (id, outcome) =>
      update(id, (entry) => {
        const rest: { -readonly [K in keyof QueuedEntry]: QueuedEntry[K] } = { ...entry, held: { ...outcome, at: new Date().toISOString() } };
        delete rest.retry;
        return rest;
      }),
    deferRetry: (id, retry) => update(id, (entry) => ({ ...entry, retry })),
    release: (id) =>
      update(id, (entry) => {
        const rest: { -readonly [K in keyof QueuedEntry]: QueuedEntry[K] } = { ...entry };
        delete rest.held;
        delete rest.retry;
        return rest;
      }),
    setUploadKey: (id, quarantineKey) =>
      update(id, (entry) => {
        if (entry.upload === undefined) return entry;
        const { bytes } = entry.upload;
        return { ...entry, upload: quarantineKey === undefined ? { bytes } : { bytes, quarantineKey } };
      }),
    clear: () => write((store) => store.clear()),
    close: () => database.close(),
  };
}
