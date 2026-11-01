import { randomUUID } from 'node:crypto';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The admin's sessions, one row each, kept on the server so that logout really ends one
 * ([AUTH-8], [AUTH-9]). A row holds the SHA-256 of the session id, never the id the cookie
 * carries, so a copy of the table signs nobody in.
 *
 * A session ends when its idle lifetime has passed since `last_seen_at` or its absolute lifetime
 * since `created_at`, both checked on the server against the deployment's configuration
 * ([AUTH-11]). Logout deletes the row.
 *
 * `key_fingerprint` names the key that signed the session's cookie (`keyFingerprint`,
 * `src/server/auth/cookie.ts`). A session is accepted only while it matches the current key's,
 * and the rows of any other key are deleted by the deploy's migration step and at each sign-in
 * ([AUTH-10]). A row with none, from before the column, is never accepted.
 */
export const adminSession = pgTable('admin_session', {
  // The application makes every key, never the database ([PLAT-13]).
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  idHash: text('id_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
  keyFingerprint: text('key_fingerprint'),
});
