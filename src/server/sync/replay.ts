/**
 * The offline-sync replay: the server half of offline entry (brief #6, decision 2). The admin's
 * device queues mutations while it has no network and sends them here in a batch when it has one
 * again (`src/app/admin/api/sync/route.ts`).
 *
 * For each mutation, in the order the client queued it ([SYNC-4]):
 *
 * 1. Its envelope and its input are validated, the input with the schema of the service function
 *    it names. A name the registry doesn't hold, or input its schema refuses, is `invalid`
 *    ([SYNC-1]).
 * 2. In a transaction of its own, the record that its id was applied is inserted first. If the id
 *    is already recorded, that insert does nothing (a concurrent replay of the same id waits for
 *    the first to commit), and the mutation is `already-applied` with the first result when its
 *    payload hash is the same, or a `conflict` when it is not ([SYNC-2], [SYNC-3]).
 * 3. For a versioned record, the record's current version must be the mutation's base version, or
 *    the mutation is a `conflict` and is answered with the server's version ([SYNC-3]).
 * 4. The service function runs with the session's `AdminContext`, its change joins the
 *    transaction (`db()`, `../transaction.ts`), and its result is stored in the record. The
 *    record and the change commit together, or neither does ([SYNC-2]).
 *
 * Anything that throws in 2 to 4 rolls the transaction back and makes the mutation `failed`; the
 * batch goes on with the next one. `sync.conflict` and `sync.mutation.failed` log the mutation's
 * id and name, and never its payload.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { appliedMutation } from '../../db/schema/applied-mutation';
import { adminOperation, type AdminContext } from '../auth/admin-context';
import { logger as defaultLogger, type Logger } from '../logger';
import { db, inTransaction } from '../transaction';
import { MUTATIONS, type SyncMutation, type SyncRegistry } from './registry';

/** The most mutations one batch may carry; a longer queue is sent in several batches. */
export const MAX_BATCH = 100;

/** A batch as the client sends it. Each mutation is checked on its own, so one bad one spoils no other. */
export const SyncBatch = z.object({ mutations: z.array(z.unknown()).min(1).max(MAX_BATCH) });
export type SyncBatch = z.infer<typeof SyncBatch>;

/** One queued mutation: the client's id for it, the service function it names, and that function's input. */
export const QueuedMutation = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  input: z.unknown(),
  /** The version of the record the change was made against, for a versioned mutation; null to create it. */
  baseVersion: z.number().int().nonnegative().nullable().optional(),
});
export type QueuedMutation = z.infer<typeof QueuedMutation>;

/** What one mutation came to, in the order the batch carried them ([SYNC-4]). */
export type MutationOutcome =
  | { readonly id: string; readonly outcome: 'applied'; readonly result: unknown }
  | { readonly id: string; readonly outcome: 'already-applied'; readonly result: unknown }
  | {
      readonly id: string;
      readonly outcome: 'conflict';
      /** `payload`: the id was applied before with another payload. `version`: the record moved on. */
      readonly reason: 'payload';
      /** What the first mutation under this id returned: the server's version of it. */
      readonly result: unknown;
    }
  | {
      readonly id: string;
      readonly outcome: 'conflict';
      readonly reason: 'version';
      readonly currentVersion: number | null;
      readonly current: unknown;
    }
  | { readonly id: string | null; readonly outcome: 'invalid'; readonly issues: readonly string[] }
  | { readonly id: string; readonly outcome: 'failed'; readonly requestId: string };

export interface SyncResponse {
  readonly outcomes: readonly MutationOutcome[];
}

/** Thrown inside a mutation's transaction to roll it back with an outcome that is not a failure. */
class Settled extends Error {
  constructor(readonly outcome: MutationOutcome) {
    super(`the mutation settled as ${outcome.outcome}`);
  }
}

/** JSON with every object's keys sorted, so equal payloads hash the same whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The SHA-256 of what a mutation asks for: its name, its input and its base version. */
export function payloadHash(mutation: Pick<QueuedMutation, 'name' | 'input' | 'baseVersion'>): string {
  const payload = canonicalJson({ name: mutation.name, input: mutation.input, baseVersion: mutation.baseVersion ?? null });
  return createHash('sha256').update(payload).digest('hex');
}

function issuesOf(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) => `${[prefix, ...issue.path.map(String)].join('.')}: ${issue.message}`);
}

/** The id a mutation carries, when it carries a usable one, for an outcome that refuses it. */
function idOf(raw: unknown): string | null {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === 'string' && z.uuid().safeParse(id).success ? id : null;
}

/** The innermost cause of an error, whose message names what failed without Drizzle's query parameters. */
function rootCause(error: unknown): { type: string; message: string } {
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  if (current instanceof Error) return { type: current.name, message: current.message };
  return { type: typeof current, message: 'a value that is not an Error was thrown' };
}

/** Checks one mutation against the registry before anything runs: an outcome when it is invalid. */
function validate(
  raw: unknown,
  registry: SyncRegistry,
): { mutation: QueuedMutation; entry: SyncMutation; input: unknown } | MutationOutcome {
  const envelope = QueuedMutation.safeParse(raw);
  if (!envelope.success) return { id: idOf(raw), outcome: 'invalid', issues: issuesOf(envelope.error, 'mutation') };
  const mutation = envelope.data;
  const entry = registry.get(mutation.name);
  if (entry === undefined) {
    return { id: mutation.id, outcome: 'invalid', issues: [`name: no service function is registered as ${JSON.stringify(mutation.name)}`] };
  }
  const input = entry.input.safeParse(mutation.input);
  if (!input.success) return { id: mutation.id, outcome: 'invalid', issues: issuesOf(input.error, 'input') };
  const versioned = entry.currentVersion !== undefined;
  if (versioned && mutation.baseVersion === undefined) {
    return { id: mutation.id, outcome: 'invalid', issues: ['baseVersion: this mutation changes a versioned record and needs the version it was made against'] };
  }
  if (!versioned && mutation.baseVersion !== undefined) {
    return { id: mutation.id, outcome: 'invalid', issues: ['baseVersion: this mutation changes no versioned record'] };
  }
  return { mutation, entry, input: input.data };
}

/** Applies one valid mutation in a transaction of its own. */
async function applyOne(admin: AdminContext, mutation: QueuedMutation, entry: SyncMutation, input: unknown): Promise<MutationOutcome> {
  const hash = payloadHash(mutation);
  return inTransaction(async () => {
    const [claimed] = await db()
      .insert(appliedMutation)
      .values({ id: mutation.id, name: mutation.name, payloadHash: hash, appliedAt: new Date() })
      .onConflictDoNothing({ target: appliedMutation.id })
      .returning({ id: appliedMutation.id });
    if (claimed === undefined) {
      const [first] = await db()
        .select({ payloadHash: appliedMutation.payloadHash, result: appliedMutation.result })
        .from(appliedMutation)
        .where(eq(appliedMutation.id, mutation.id));
      if (first === undefined) throw new Error('the applied-mutation record could not be claimed or read');
      const result: unknown = first.result === null ? null : JSON.parse(first.result);
      throw new Settled(
        first.payloadHash === hash
          ? { id: mutation.id, outcome: 'already-applied', result }
          : { id: mutation.id, outcome: 'conflict', reason: 'payload', result },
      );
    }

    if (entry.currentVersion !== undefined) {
      const current = await entry.currentVersion(input);
      const currentVersion = current?.version ?? null;
      if (currentVersion !== (mutation.baseVersion ?? null)) {
        throw new Settled({ id: mutation.id, outcome: 'conflict', reason: 'version', currentVersion, current: current?.record ?? null });
      }
    }

    // The service function checks the context and parses its input itself: it is called exactly
    // as the admin UI calls it ([SYNC-1], AGENTS.md §4).
    const result = (await entry.apply(admin, mutation.input as never)) ?? null;
    const stored = JSON.stringify(result);
    await db().update(appliedMutation).set({ result: stored }).where(eq(appliedMutation.id, mutation.id));
    return { id: mutation.id, outcome: 'applied', result: JSON.parse(stored) as unknown } as const;
  }).catch((error: unknown) => {
    if (error instanceof Settled) return error.outcome;
    throw error;
  });
}

/**
 * Builds the replay over a registry: the production endpoint uses `MUTATIONS`, and tests their
 * own. The replay is a service function itself, so it refuses anything but an `AdminContext`
 * the session check issued before it looks at a single mutation.
 */
export function createReplay(registry: SyncRegistry, options: { readonly log?: Logger } = {}) {
  const log = options.log ?? defaultLogger;
  return adminOperation(SyncBatch, async (admin, batch): Promise<SyncResponse> => {
    const outcomes: MutationOutcome[] = [];
    for (const raw of batch.mutations) {
      const checked = validate(raw, registry);
      if ('outcome' in checked) {
        outcomes.push(checked);
        continue;
      }
      const { mutation, entry, input } = checked;
      let outcome: MutationOutcome;
      try {
        outcome = await applyOne(admin, mutation, entry, input);
      } catch (error) {
        log.error(
          { businessEvent: 'sync.mutation.failed', mutationId: mutation.id, mutation: mutation.name, requestId: admin.requestId, cause: rootCause(error) },
          'an offline mutation failed on the server and was rolled back',
        );
        outcome = { id: mutation.id, outcome: 'failed', requestId: admin.requestId };
      }
      if (outcome.outcome === 'conflict') {
        log.warn(
          { businessEvent: 'sync.conflict', mutationId: mutation.id, mutation: mutation.name, reason: outcome.reason, requestId: admin.requestId },
          'an offline mutation conflicts with the server and was not applied',
        );
      }
      outcomes.push(outcome);
    }
    return { outcomes };
  });
}

/** The replay the deployed endpoint runs, over the production registry. */
export const replayMutations = createReplay(MUTATIONS);
