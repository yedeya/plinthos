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
 * - `not-attempted` leaves it queued as it was.
 *
 * There is still no timer: a failed mutation is retried at the next open or reconnect after its
 * backoff, never by the replay waking itself.
 *
 * An answer of 401 means the session ended: the replay stops with the queue untouched, and the
 * page sends the admin to the login; the next open after sign-in replays it. A network failure,
 * a timeout or any other answer stops it the same way, to be tried at the next trigger.
 */
import type { HeldOutcome, OfflineQueue, QueuedEntry } from './queue';

/** The offline-sync endpoint (`src/app/admin/api/sync/route.ts`). */
export const SYNC_ENDPOINT = '/admin/api/sync';

/** The endpoint's own limit, `MAX_BATCH` in `src/server/sync/replay.ts`. */
export const BATCH_SIZE = 100;

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

export interface ReplayResult {
  readonly status: ReplayStatus;
  /** How many mutations left the queue as applied in this replay. */
  readonly applied: number;
  /** How many are still queued. */
  readonly pending: number;
}

export interface ReplayOptions {
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  /** The clock, for the retry backoff. */
  readonly now?: () => number;
}

interface Outcome {
  readonly outcome?: unknown;
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
      return { outcome: 'invalid', issues: Array.isArray(outcome.issues) ? outcome.issues.filter((issue): issue is string => typeof issue === 'string') : [] };
    case 'failed':
      return { outcome: 'failed', requestId: typeof outcome.requestId === 'string' ? outcome.requestId : '' };
    default:
      return null;
  }
}

function envelope(entry: QueuedEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    input: entry.input,
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
  let applied = 0;
  const finish = async (status: ReplayStatus): Promise<ReplayResult> => ({ status, applied, pending: await queue.count() });

  for (;;) {
    const entries = await queue.entries();
    if (entries.length === 0) return finish('synced');
    const firstHeld = entries.findIndex((entry) => entry.held !== undefined);
    if (firstHeld === 0) return finish('held');
    const head = entries[0];
    if (head?.retry !== undefined && Date.parse(head.retry.notBefore) > now()) return finish('retrying');
    const batch = entries.slice(0, firstHeld === -1 ? batchSize : Math.min(firstHeld, batchSize));

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
      const body = (await response.json()) as { outcomes?: unknown };
      if (!Array.isArray(body.outcomes) || body.outcomes.length !== batch.length) return finish('error');
      outcomes = body.outcomes as Outcome[];
    } catch {
      return finish('error');
    }

    for (const [index, entry] of batch.entries()) {
      const outcome = outcomes[index] ?? {};
      if (outcome.outcome === 'applied' || outcome.outcome === 'already-applied') {
        await queue.remove(entry.id);
        applied++;
        continue;
      }
      const held = heldOutcome(outcome);
      if (held?.outcome === 'failed') {
        const failures = (entry.retry?.failures ?? 0) + 1;
        if (failures < MAX_FAILED_ATTEMPTS) {
          await queue.deferRetry(entry.id, { failures, notBefore: new Date(now() + retryDelayMs(failures)).toISOString(), requestId: held.requestId });
          return finish('retrying');
        }
      }
      if (held !== null) {
        await queue.hold(entry.id, held);
        return finish('held');
      }
      // `not-attempted`, or an answer it doesn't know: it stays queued as it was.
      return finish('error');
    }
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
