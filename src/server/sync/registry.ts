/**
 * The mutations the offline-sync endpoint may replay: each queued name mapped to the typed
 * service function it runs and the zod schema that function validates with (`AGENTS.md` §4,
 * [SYNC-1]). The replay calls nothing else that changes data, so a name missing here is refused
 * as invalid, and a mutation can never reach a function that skips the admin check.
 *
 * The walking skeleton registers none yet: its first production mutations are `registerPhoto`
 * and `deletePhoto`, which #22 adds (brief #6, decision 19). Until then the tests drive every
 * rule with test-only mutations, registered in a registry of their own.
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
   */
  readonly currentVersion?: (input: z.output<Schema>) => Promise<CurrentVersion | null>;
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

/** The production registry: every mutation the deployed endpoint replays. */
export const MUTATIONS: SyncRegistry = syncRegistry([]);
