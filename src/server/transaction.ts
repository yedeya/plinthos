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

const open = new AsyncLocalStorage<ServiceTransaction>();

/** The transaction this call runs in, or the database when it runs in none. */
export function db(): Executor {
  return open.getStore() ?? (database() as unknown as ServiceDatabase);
}

/**
 * Runs `work` in a transaction: the one this call already runs in, or else a new one, which
 * commits when `work` resolves and rolls back when it throws.
 */
export async function inTransaction<T>(work: (tx: ServiceTransaction) => Promise<T>): Promise<T> {
  const current = open.getStore();
  if (current !== undefined) return work(current);
  return (database() as unknown as ServiceDatabase).transaction((tx) => open.run(tx, () => work(tx)));
}
