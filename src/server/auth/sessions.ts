/**
 * The admin's sessions, kept on the server ([AUTH-8] to [AUTH-11]).
 *
 * `authenticate` is the one way to an `AdminContext`. It checks the cookie's signature first,
 * from configuration alone, so a request with no cookie or a forged one is refused without
 * calling the database ([AUTH-6]). Only a correctly signed cookie leads to the database, where
 * its session must exist and neither its idle nor its absolute lifetime may have passed; the
 * same statement records the visit, which restarts the idle lifetime.
 *
 * `endSession` deletes the session's row, so the same cookie replayed afterwards is refused
 * ([AUTH-9]). Changing the password hash, the username or the session secret ends every session,
 * because the cookie key is derived from them (`./cookie.ts`, [AUTH-10]).
 */
import { and, eq, gt, lte, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { adminSession } from '../../db/schema/admin-session';
import type * as schema from '../../db/schema';
import { database } from '../database';
import { logger } from '../logger';
import { assertAdmin, issueAdminContext, type AdminContext } from './admin-context';
import { authConfig, type AuthConfig } from './config';
import { hashSessionId, newSessionId, signingKey, signSessionId, verifySessionCookie } from './cookie';

/** Either of Drizzle's PostgreSQL drivers: the Data API in deployment, TCP in tests. */
export type SessionDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

const keys = new WeakMap<AuthConfig, Buffer>();

/** The key this configuration signs cookies with. */
export function cookieKey(config: AuthConfig): Buffer {
  let key = keys.get(config);
  if (key === undefined) {
    key = signingKey({ sessionSecret: config.sessionSecret, username: config.username, passwordHash: config.passwordHashValue });
    keys.set(config, key);
  }
  return key;
}

/**
 * The `AdminContext` for a session cookie, or null when it has none, its signature fails, or its
 * session has ended or never existed.
 */
export async function authenticate(cookieValue: string | undefined, requestId: string): Promise<AdminContext | null> {
  if (cookieValue === undefined || cookieValue === '') return null;
  const config = authConfig();
  const sessionId = verifySessionCookie(cookieValue, cookieKey(config));
  if (sessionId === null) return null;

  const now = new Date();
  const db = database() as unknown as SessionDatabase;
  const [row] = await db
    .update(adminSession)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(adminSession.idHash, hashSessionId(sessionId)),
        gt(adminSession.lastSeenAt, new Date(now.getTime() - config.idleMs)),
        gt(adminSession.createdAt, new Date(now.getTime() - config.absoluteMs)),
      ),
    )
    .returning({ id: adminSession.id });
  return row === undefined ? null : issueAdminContext({ sessionKey: row.id, requestId });
}

/** A new session's cookie value and how long the cookie lives, in seconds. */
export interface NewSession {
  readonly cookieValue: string;
  readonly maxAgeSeconds: number;
}

/** Starts a session after a successful sign-in, and clears every ended one. */
export async function startSession(): Promise<NewSession> {
  const config = authConfig();
  const now = new Date();
  const sessionId = newSessionId();
  const db = database() as unknown as SessionDatabase;
  await db
    .delete(adminSession)
    .where(
      or(
        lte(adminSession.lastSeenAt, new Date(now.getTime() - config.idleMs)),
        lte(adminSession.createdAt, new Date(now.getTime() - config.absoluteMs)),
      ),
    );
  await db.insert(adminSession).values({ idHash: hashSessionId(sessionId), createdAt: now, lastSeenAt: now });
  return { cookieValue: signSessionId(sessionId, cookieKey(config)), maxAgeSeconds: Math.floor(config.absoluteMs / 1000) };
}

/** Ends the admin's own session on the server ([AUTH-9]). */
export async function endSession(admin: AdminContext): Promise<void> {
  assertAdmin(admin);
  const db = database() as unknown as SessionDatabase;
  await db.delete(adminSession).where(eq(adminSession.id, admin.sessionKey));
  logger.info({ businessEvent: 'auth.session.revoked', requestId: admin.requestId }, 'the admin signed out: the session is revoked');
}
