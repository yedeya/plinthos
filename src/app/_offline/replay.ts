/**
 * Replays the device's queue into the offline-sync endpoint ([SYNC-7], [SYNC-8]), when the
 * network returns and when the admin is opened, never on a timer.
 *
 * It sends the queue's head, up to the endpoint's batch size, in queue order, and acts on each
 * outcome the endpoint answers ([SYNC-4]):
 *
 * - `applied` and `already-applied` take the mutation out of the queue;
 * - `conflict` and `invalid` hold it in its place, with what the server said, and stop the
 *   replay: nothing queued after it is sent until the admin retries it or discards it;
 * - `failed`, which is often passing (an Aurora resume, a cold start), keeps it in its place and
 *   stops the replay, to be sent again by a later trigger once its backoff has passed
 *   (`retryDelayMs`). Its `MAX_FAILED_ATTEMPTS`th failure holds it like a conflict (the Owner's
 *   decision on #73). While it waits, everything queued after it waits behind it ([SYNC-4]);
 * - `not-attempted` leaves it queued as it was. When every mutation before it was applied, the
 *   server ran out of the batch's time ([SYNC-11], #138), so the rest is sent at once in the next
 *   batch; when it is the batch's first, the server ran none of it, and the replay stops.
 *
 * There is still no timer: a failed mutation is retried at the next open or reconnect after its
 * backoff, never by the replay waking itself.
 *
 * A photo's `registerPhoto` carries its bytes (`./photos.ts`, #22). A batch carries at most
 * `MAX_PHOTOS_PER_BATCH` of them and ends before the photo that would pass the cap, which the
 * endpoint holds it to ([SYNC-10], #95). Before a batch is sent, each
 * photo in it without a quarantine key is uploaded, in queue order, and its key recorded; a
 * photo S3 refuses is held. When the server answers a photo `invalid` as `upload-missing` (its
 * quarantined object expired, or a refusal deleted it), the key is forgotten and the bytes are
 * uploaded again under the same id, once per replay; a second time holds it (#9).
 *
 * A batch that applied a delete the public catalogue may show is answered with the outcome of the
 * one republish that followed it, `catalogue` (#187, [PUB-16]). The replay carries the last one a
 * batch answered: each republish publishes everything deleted before it, so the last says whether
 * the public catalogue now matches. The admin is told from it (`./client.tsx`, #192).
 *
 * While it uploads, the replay reports its progress (`onProgress`, by default the window event
 * `QUEUE_PROGRESS`, #203): how many of the photos it uploads in this replay are up, out of how
 * many. The total is what it has uploaded so far and what the queue still holds to upload, counted
 * again before each batch, so a photo queued during the replay, or one uploaded again, joins it.
 * A replay with no photo to upload reports nothing.
 *
 * An answer of 401 means the session ended: the replay stops with the queue untouched, and the
 * page sends the admin to the login; the next open after sign-in replays it. A network failure,
 * a timeout or any other answer stops it the same way, to be tried at the next trigger.
 */
import { MAX_PHOTOS_PER_BATCH, PHOTO_MUTATION } from '../../server/sync/limits';
import { uploadPhoto } from './photos';
import type { HeldOutcome, OfflineQueue, QueuedEntry } from './queue';

/** The offline-sync endpoint (`src/app/admin/api/sync/route.ts`). */
export const SYNC_ENDPOINT = '/admin/api/sync';

/** The endpoint's own limit, `MAX_BATCH` in `src/server/sync/replay.ts`. */
export const BATCH_SIZE = 100;

/** The longest head of `entries` that carries no more than `MAX_PHOTOS_PER_BATCH` photos ([SYNC-10]). */
function withinPhotoCap(entries: readonly QueuedEntry[]): QueuedEntry[] {
  let photos = 0;
  const over = entries.findIndex((entry) => entry.name === PHOTO_MUTATION && ++photos > MAX_PHOTOS_PER_BATCH);
  return over === -1 ? [...entries] : entries.slice(0, over);
}

/** How long one batch may take: long enough for Aurora to resume from a pause. */
export const REPLAY_TIMEOUT_MS = 60_000;

/** How many times the server may answer one mutation as failed before it is held for the admin. */
export const MAX_FAILED_ATTEMPTS = 3;

/** The backoff after a mutation's first failure; each later one waits four times as long. */
export const RETRY_BASE_DELAY_MS = 30_000;

/** How long the replay waits after a mutation's `failures`th failure before it sends it again. */
export function retryDelayMs(failures: number): number {
  return RETRY_BASE_DELAY_MS * 4 ** Math.max(0, failures - 1);
}

/**
 * Whether a waiting mutation's backoff has passed. The wait is measured on the device's clock from
 * when it failed. If that clock now reads earlier than the failure (a backward correction, say),
 * it can't say how long the mutation has waited, so the mutation is due at once rather than
 * stalled with no button to free it (#89). No clock survives a reload, so a correction that leaves
 * the clock still after the failure can lengthen the wait, but never by more than one backoff
 * after the correction. A stored delay is never trusted beyond `retryDelayMs` of the same
 * failure count.
 */
export function retryDue(retry: { readonly failures: number; readonly failedAt: string; readonly delayMs: number }, now: number): boolean {
  const failedAt = Date.parse(retry.failedAt);
  if (!Number.isFinite(failedAt)) return true;
  const elapsed = now - failedAt;
  return elapsed < 0 || elapsed >= Math.min(retry.delayMs, retryDelayMs(retry.failures));
}

export type ReplayStatus =
  /** The queue is empty. */
  | 'synced'
  /** A mutation failed on the server and waits out its backoff before it is sent again. */
  | 'retrying'
  /** A mutation is held, waiting for the admin to retry or discard it. */
  | 'held'
  /** The session ended: sign in, and the replay resumes. */
  | 'signed-out'
  /** The endpoint could not be reached. */
  | 'offline'
  /** The endpoint answered something the replay can't use. */
  | 'error';

/** What the republish after a batch's deletes came to: `RepublishOutcome` in `src/server/sync/replay.ts`. */
export type CatalogueOutcome = 'updated' | 'stale' | 'not-published';

const CATALOGUE_OUTCOMES: ReadonlySet<unknown> = new Set<CatalogueOutcome>(['updated', 'stale', 'not-published']);

export interface ReplayResult {
  readonly status: ReplayStatus;
  /** How many mutations left the queue as applied in this replay. */
  readonly applied: number;
  /** How many are still queued. */
  readonly pending: number;
  /** The last `catalogue` a batch of this replay was answered with; absent when none deleted anything the catalogue may show. */
  readonly catalogue?: CatalogueOutcome;
}

/** The window event the replay sends while it uploads photos (#203), carrying an `UploadProgress`. */
export const QUEUE_PROGRESS = 'plinthos:queue-progress';

/** How far a replay's photo uploads have got: `uploaded` of `total` photos are up. */
export interface UploadProgress {
  readonly uploaded: number;
  readonly total: number;
}

/** The default reporter: the `QUEUE_PROGRESS` window event, where there is a window. */
function announceProgress(progress: UploadProgress): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<UploadProgress>(QUEUE_PROGRESS, { detail: progress }));
}

/** Whether an entry is a photo whose bytes still have to be uploaded. */
const needsUpload = (entry: QueuedEntry): boolean => entry.upload !== undefined && entry.upload.quarantineKey === undefined;

export interface ReplayOptions {
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  /** The clock, for the retry backoff. */
  readonly now?: () => number;
  /** Told how far the photo uploads have got, before the first and after each one. */
  readonly onProgress?: (progress: UploadProgress) => void;
}

interface Outcome {
  readonly outcome?: unknown;
  readonly code?: unknown;
  readonly reason?: unknown;
  readonly issues?: unknown;
  readonly requestId?: unknown;
}

/** What is kept of an outcome that holds a mutation: never the server's record. */
function heldOutcome(outcome: Outcome): HeldOutcome | null {
  switch (outcome.outcome) {
    case 'conflict':
      return { outcome: 'conflict', reason: outcome.reason === 'version' ? 'version' : 'payload' };
    case 'invalid':
      return {
        outcome: 'invalid',
        issues: Array.isArray(outcome.issues) ? outcome.issues.filter((issue): issue is string => typeof issue === 'string') : [],
        ...(typeof outcome.code === 'string' ? { code: outcome.code } : {}),
      };
    case 'failed':
      return { outcome: 'failed', requestId: typeof outcome.requestId === 'string' ? outcome.requestId : '' };
    default:
      return null;
  }
}

/** The `invalid` code with which the server says a photo's quarantined upload is gone (`REFUSALS.missing`). */
export const UPLOAD_MISSING = 'upload-missing';

function envelope(entry: QueuedEntry): Record<string, unknown> {
  // A photo's quarantine key joins its input; its bytes never go to the endpoint.
  const input = entry.upload === undefined ? entry.input : { ...(entry.input as Record<string, unknown>), quarantineKey: entry.upload.quarantineKey };
  return {
    id: entry.id,
    name: entry.name,
    input,
    ...(entry.baseVersion === undefined ? {} : { baseVersion: entry.baseVersion }),
  };
}

/** Replays the queue once, as far as it goes. */
export async function replayQueue(queue: OfflineQueue, options: ReplayOptions = {}): Promise<ReplayResult> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = options.endpoint ?? SYNC_ENDPOINT;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const timeoutMs = options.timeoutMs ?? REPLAY_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const report = options.onProgress ?? announceProgress;
  let applied = 0;
  let uploaded = 0;
  let catalogue: CatalogueOutcome | undefined;
  const uploadedAgain = new Set<string>();
  const finish = async (status: ReplayStatus): Promise<ReplayResult> => ({ status, applied, pending: await queue.count(), ...(catalogue === undefined ? {} : { catalogue }) });

  for (;;) {
    const entries = await queue.entries();
    if (entries.length === 0) return finish('synced');
    const firstHeld = entries.findIndex((entry) => entry.held !== undefined);
    if (firstHeld === 0) return finish('held');
    const head = entries[0];
    if (head?.retry !== undefined && !retryDue(head.retry, now())) return finish('retrying');
    let batch = withinPhotoCap(entries.slice(0, firstHeld === -1 ? batchSize : Math.min(firstHeld, batchSize)));

    // Upload the batch's photos that have no quarantined object yet, in queue order, reporting
    // how far they have got out of every photo the queue still holds to upload before a held one.
    const total = uploaded + entries.slice(0, firstHeld === -1 ? entries.length : firstHeld).filter(needsUpload).length;
    if (batch.some(needsUpload)) report({ uploaded, total });
    for (const [index, entry] of batch.entries()) {
      if (entry.upload === undefined || entry.upload.quarantineKey !== undefined) continue;
      const upload = await uploadPhoto(entry, { fetch: send, timeoutMs });
      if (upload.status === 'uploaded') {
        await queue.setUploadKey(entry.id, upload.quarantineKey);
        batch[index] = { ...entry, upload: { bytes: entry.upload.bytes, quarantineKey: upload.quarantineKey } };
        report({ uploaded: ++uploaded, total });
        continue;
      }
      if (upload.status === 'signed-out') return finish('signed-out');
      if (upload.status === 'offline') return finish('offline');
      if (upload.status === 'error') return finish('error');
      await queue.hold(entry.id, { outcome: 'invalid', issues: [upload.issue] });
      if (index === 0) return finish('held');
      batch = batch.slice(0, index);
      break;
    }

    let response: Response;
    try {
      response = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mutations: batch.map(envelope) }),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return finish('offline');
    }
    if (response.status === 401) return finish('signed-out');
    if (!response.ok) return finish('error');

    let outcomes: readonly Outcome[];
    try {
      const body = (await response.json()) as { outcomes?: unknown; catalogue?: unknown };
      if (!Array.isArray(body.outcomes) || body.outcomes.length !== batch.length) return finish('error');
      outcomes = body.outcomes as Outcome[];
      if (CATALOGUE_OUTCOMES.has(body.catalogue)) catalogue = body.catalogue as CatalogueOutcome;
    } catch {
      return finish('error');
    }

    let uploadAgain = false;
    for (const [index, entry] of batch.entries()) {
      const outcome = outcomes[index] ?? {};
      if (outcome.outcome === 'applied' || outcome.outcome === 'already-applied') {
        await queue.remove(entry.id);
        applied++;
        continue;
      }
      // The photo's upload is gone, and the server stored nothing: upload the bytes again, once.
      if (outcome.outcome === 'invalid' && outcome.code === UPLOAD_MISSING && entry.upload !== undefined && !uploadedAgain.has(entry.id)) {
        uploadedAgain.add(entry.id);
        await queue.setUploadKey(entry.id, undefined);
        uploadAgain = true;
        break;
      }
      const held = heldOutcome(outcome);
      if (held?.outcome === 'failed') {
        const failures = (entry.retry?.failures ?? 0) + 1;
        if (failures < MAX_FAILED_ATTEMPTS) {
          await queue.deferRetry(entry.id, { failures, failedAt: new Date(now()).toISOString(), delayMs: retryDelayMs(failures), requestId: held.requestId });
          return finish('retrying');
        }
      }
      if (held !== null) {
        await queue.hold(entry.id, held);
        return finish('held');
      }
      // Past the batch's time, after at least one applied: the rest goes in the next batch ([SYNC-11]).
      if (outcome.outcome === 'not-attempted' && index > 0) break;
      // `not-attempted` with nothing applied, or an answer it doesn't know: it stays queued as it was.
      return finish('error');
    }
    if (uploadAgain) continue;
  }
}

let running: Promise<ReplayResult> | null = null;

/**
 * Replays the queue unless a replay is already running, in this tab or, where the browser has
 * Web Locks, in another one; a second trigger waits for the first and shares its result.
 */
export function replayOnce(queue: OfflineQueue, options: ReplayOptions = {}): Promise<ReplayResult> {
  if (running !== null) return running;
  const locks = typeof navigator === 'undefined' ? undefined : (navigator.locks as LockManager | null | undefined);
  const run = locks == null ? replayQueue(queue, options) : (locks.request('plinthos-offline-replay', () => replayQueue(queue, options)) as Promise<ReplayResult>);
  running = run.finally(() => {
    running = null;
  });
  return running;
}
