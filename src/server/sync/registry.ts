/**
 * The mutations the offline-sync endpoint may replay: each queued name mapped to the typed
 * service function it runs and the zod schema that function validates with (`AGENTS.md` §4,
 * [SYNC-1]). The replay calls nothing else that changes data, so a name missing here is refused
 * as invalid, and a mutation can never reach a function that skips the admin check.
 *
 * The production registry, `MUTATIONS`, is in `./mutations.ts`: the walking skeleton's are
 * `registerPhoto` and `deletePhoto` (#22, brief #6, decision 19), and set entry's are `saveItem`,
 * the first versioned record, `deleteItem` and `setItemPhotos` (#124).
 */
import type { z } from 'zod';
import type { AdminContext } from '../auth/admin-context';

/** The server's current version of the record a versioned mutation changes, and the record itself. */
export interface CurrentVersion {
  readonly version: number;
  /** What the client is shown on a conflict, so it can rebase or discard its change. */
  readonly record: unknown;
}

/** One replayable mutation: a service function built with `adminOperation`, and its input schema. */
export interface SyncMutation<Schema extends z.ZodType = z.ZodType, Result = unknown> {
  /** The name the client queues it under. */
  readonly name: string;
  /** The schema the service function itself validates with, so an invalid mutation is answered as such. */
  readonly input: Schema;
  /**
   * The service function. It takes the session's `AdminContext` and the input as the client sent
   * it, and checks and parses both itself (`adminOperation`). It reads and writes through
   * `db()` (`../transaction.ts`), so its change joins the replay's transaction. Its result must
   * be JSON, since the replay stores it for a replay of the same id.
   */
  readonly apply: (admin: AdminContext, input: z.input<Schema>) => Promise<Result>;
  /**
   * For a mutation that changes a versioned record: the record's current version, or null when it
   * doesn't exist yet. It runs inside the mutation's transaction, before `apply`, and should lock
   * the row it reads (`for update`), so no other transaction moves the version between the check
   * and the change. A versioned mutation must carry `baseVersion`, null to create the record
   * ([SYNC-3]).
   *
   * Racing creates: when the record doesn't exist yet, `for update` locks nothing, so two
   * mutations with different ids that both create it (`baseVersion: null`) can both pass the
   * check. The create must therefore insert without an upsert, so the record's primary key
   * refuses the second one, rather than silently overwriting the first. The replay then reads the
   * record again in a new transaction and, finding it, answers the second create as a `version`
   * conflict with the server's record rather than `failed` (`racedCreate` in `./replay.ts`,
   * [ITEM-3]).
   */
  readonly currentVersion?: (input: z.output<Schema>) => Promise<CurrentVersion | null>;
  /**
   * For a versioned mutation whose service function needs the base version itself, as
   * `saveItem` does to insert rather than update (#124): the base version its input carries. The
   * envelope may then leave `baseVersion` out, and one that carries it must carry the same, or
   * the mutation is invalid.
   */
  readonly baseVersionOf?: (input: z.output<Schema>) => number | null;
  /**
   * What the applied-mutation record compares a replay of the same id by, when it is not the
   * whole input: for `registerPhoto`, the photo's SHA-256 and not the quarantine key, so that a
   * re-upload of the same photo under a new key is already applied and not a conflict
   * ([PHOTO-2], #9). Without it, the whole input is compared.
   */
  readonly payloadKey?: (input: z.output<Schema>) => unknown;
  /**
   * Runs once the mutation's transaction has ended, whatever it came to: applied, already
   * applied, a conflict, refused as invalid by the service function, or failed. It is for a
   * change outside the database that every outcome must make, such as deleting the quarantined
   * upload `registerPhoto` was given ([PHOTO-3], #9). It never runs for a mutation whose input
   * its schema refused, nor for one that was not attempted. What it throws is logged and changes
   * no outcome.
   */
  readonly settled?: (admin: AdminContext, input: z.output<Schema>, settlement: Settlement) => Promise<void>;
}

/** What a mutation with valid input came to, as `settled` sees it. */
export interface Settlement {
  /** The client's id for the mutation. */
  readonly id: string;
  readonly outcome: 'applied' | 'already-applied' | 'conflict' | 'invalid' | 'failed';
  /** For a mutation the service function refused (`MutationRefused`), its code. */
  readonly code?: string;
}

/**
 * Thrown by a service function to refuse its input as invalid after it has looked at it, such as
 * a photo whose bytes don't match its hash. Its transaction rolls back and records nothing, and
 * the replay answers the mutation as `invalid` with these issues and `code`, which the client can
 * act on: `upload-missing` tells it to upload the photo again (#9).
 */
export class MutationRefused extends Error {
  override name = 'MutationRefused';
  constructor(
    readonly code: string,
    readonly issues: readonly string[],
  ) {
    super(`the mutation was refused: ${code}`);
  }
}

/** The names the endpoint knows, each mapped to its mutation. */
export type SyncRegistry = ReadonlyMap<string, SyncMutation>;

/** Builds a registry, refusing two mutations under one name. */
export function syncRegistry(mutations: readonly SyncMutation[]): SyncRegistry {
  const registry = new Map<string, SyncMutation>();
  for (const mutation of mutations) {
    if (registry.has(mutation.name)) throw new Error(`two sync mutations are named ${mutation.name}`);
    registry.set(mutation.name, mutation);
  }
  return registry;
}

/** Declares one mutation, keeping its schema and its service function's input type together. */
export function syncMutation<Schema extends z.ZodType, Result>(mutation: SyncMutation<Schema, Result>): SyncMutation {
  return mutation as unknown as SyncMutation;
}
