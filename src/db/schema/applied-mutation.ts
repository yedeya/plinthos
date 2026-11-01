import { randomUUID } from 'node:crypto';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Every mutation the offline-sync endpoint has applied, one row each, keyed by the id the client
 * gave it when it queued the mutation ([SYNC-2], `src/server/sync/`).
 *
 * The row is written in the same transaction as the change the mutation made, so "applied" and
 * "changed" always agree: a mutation that rolls back leaves no row, and a row means its change
 * committed. A replay of the same id finds the row: with the same payload hash it is answered
 * with the stored result and changes nothing; with another hash it is a conflict ([SYNC-3]).
 *
 * `result` is the service function's result as JSON text, not `jsonb`, so the Data API driver
 * needs no type hint for it.
 */
export const appliedMutation = pgTable('applied_mutation', {
  // The client's own UUID for the mutation. The application makes every key, never the database
  // ([PLAT-13]); the default is never used, since the replay always gives the client's id.
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  payloadHash: text('payload_hash').notNull(),
  result: text('result'),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull(),
});
