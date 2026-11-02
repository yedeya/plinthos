/**
 * The service core's one way into a transaction, so that a caller can make a service function's
 * change part of its own transaction without passing a handle through the function's signature.
 *
 * A service function reads and writes through `db()`. Outside a transaction that is the database
 * itself (`./database.ts`); inside `inTransaction` it is that transaction. The offline-sync
 * replay (`./sync/replay.ts`) opens one per mutation, so the service function's change and the
 * record that the mutation was applied commit or roll back together ([SYNC-2]). A service
 * function that opens its own `inTransaction` inside the replay's joins the replay's, rather than
 * committing on its own.
 *
 * A change outside the database that must follow the commit, such as deleting a photo's stored
 * files once its row is gone, is registered with `afterCommit`: it runs once the outermost
 * transaction has committed, and never when it rolls back.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from '../db/schema';
import { database } from './database';

/** Either of Drizzle's PostgreSQL drivers: the Data API in deployment, TCP in tests. */
export type ServiceDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
export type ServiceTransaction = PgTransaction<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** What a service function queries: the database, or the transaction it runs in. */
export type Executor = ServiceDatabase | ServiceTransaction;

interface OpenTransaction {
  readonly tx: ServiceTransaction;
  /** What runs once the outermost transaction has committed, in the order it was registered. */
  readonly afterCommit: (() => Promise<void>)[];
}

const open = new AsyncLocalStorage<OpenTransaction>();

/** The transaction this call runs in, or the database when it runs in none. */
export function db(): Executor {
  return open.getStore()?.tx ?? (database() as unknown as ServiceDatabase);
}

/**
 * Runs `work` once the transaction this call runs in has committed, and not at all if it rolls
 * back. The commit has happened by then, so `work` must handle its own failure: whatever it
 * throws is swallowed rather than reported as the transaction's. Outside a transaction it refuses.
 */
export function afterCommit(work: () => Promise<void>): void {
  const current = open.getStore();
  if (current === undefined) throw new Error('afterCommit needs a transaction: call it inside inTransaction');
  current.afterCommit.push(work);
}

/**
 * Runs `work` in a transaction: the one this call already runs in, or else a new one, which
 * commits when `work` resolves and rolls back when it throws.
 */
export async function inTransaction<T>(work: (tx: ServiceTransaction) => Promise<T>): Promise<T> {
  const current = open.getStore();
  if (current !== undefined) return work(current.tx);
  const after: (() => Promise<void>)[] = [];
  const result = await (database() as unknown as ServiceDatabase).transaction((tx) => open.run({ tx, afterCommit: after }, () => work(tx)));
  for (const next of after) await next().catch(() => undefined);
  return result;
}
