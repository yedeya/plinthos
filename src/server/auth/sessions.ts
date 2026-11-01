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
 * because the cookie key is derived from them (`./cookie.ts`, [AUTH-10]). Each row records its
 * key's fingerprint, and a session is accepted only while that is the current key's. The deploy's
 * migration step deletes the rows of every other key (`revokeSessionsSignedWithAnotherKey`), and
 * so does each sign-in, so setting a credential back to an earlier value revives none of them.
 */
import { and, eq, gt, isNull, lte, ne, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { adminSession } from '../../db/schema/admin-session';
import type * as schema from '../../db/schema';
import { z } from 'zod';
import { database } from '../database';
import { logger } from '../logger';
import { assertAdmin, issueAdminContext, type AdminContext } from './admin-context';
import { authConfig, type AuthConfig } from './config';
import { hashSessionId, keyFingerprint, newSessionId, signingKey, signSessionId, verifySessionCookie } from './cookie';

/** Either of Drizzle's PostgreSQL drivers: the Data API in deployment, TCP in tests. */
export type SessionDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

const keys = new WeakMap<AuthConfig, Buffer>();
const fingerprints = new WeakMap<AuthConfig, string>();

/** The key this configuration signs cookies with. */
export function cookieKey(config: AuthConfig): Buffer {
  let key = keys.get(config);
  if (key === undefined) {
    key = signingKey({ sessionSecret: config.sessionSecret, username: config.username, passwordHash: config.passwordHashValue });
    keys.set(config, key);
  }
  return key;
}

/** The fingerprint of that key, which each session's row records ([AUTH-10]). */
export function sessionKeyFingerprint(config: AuthConfig): string {
  let fingerprint = fingerprints.get(config);
  if (fingerprint === undefined) {
    fingerprint = keyFingerprint(cookieKey(config));
    fingerprints.set(config, fingerprint);
  }
  return fingerprint;
}

/** Whether a row was signed with a key other than the one this fingerprint names, or with none on record. */
const signedWithAnotherKey = (fingerprint: string) => or(isNull(adminSession.keyFingerprint), ne(adminSession.keyFingerprint, fingerprint));

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
        eq(adminSession.keyFingerprint, sessionKeyFingerprint(config)),
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

/** Starts a session after a successful sign-in, and clears every ended one, a credential change's included. */
export async function startSession(): Promise<NewSession> {
  const config = authConfig();
  const now = new Date();
  const sessionId = newSessionId();
  const fingerprint = sessionKeyFingerprint(config);
  const db = database() as unknown as SessionDatabase;
  await db
    .delete(adminSession)
    .where(
      or(
        lte(adminSession.lastSeenAt, new Date(now.getTime() - config.idleMs)),
        lte(adminSession.createdAt, new Date(now.getTime() - config.absoluteMs)),
        signedWithAnotherKey(fingerprint),
      ),
    );
  await db.insert(adminSession).values({ idHash: hashSessionId(sessionId), createdAt: now, lastSeenAt: now, keyFingerprint: fingerprint });
  return { cookieValue: signSessionId(sessionId, cookieKey(config)), maxAgeSeconds: Math.floor(config.absoluteMs / 1000) };
}

/** Ends the admin's own session on the server ([AUTH-9]). */
export async function endSession(admin: AdminContext): Promise<void> {
  assertAdmin(admin);
  const db = database() as unknown as SessionDatabase;
  await db.delete(adminSession).where(eq(adminSession.id, admin.sessionKey));
  logger.info({ businessEvent: 'auth.session.revoked', requestId: admin.requestId }, 'the admin signed out: the session is revoked');
}

const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/, 'a key fingerprint is 64 hex digits');

/**
 * Deletes every session signed with a key other than the one `fingerprint` names, and every
 * session with no fingerprint on record, and says how many it deleted ([AUTH-10]). The deploy's
 * migration step runs it with the deployed configuration's fingerprint (`scripts/migrate.ts`), so
 * the sessions a credential change ended are gone before the earlier value could be set again.
 */
export async function revokeSessionsSignedWithAnotherKey(db: SessionDatabase, fingerprint: string): Promise<number> {
  const current = Fingerprint.parse(fingerprint);
  const deleted = await db.delete(adminSession).where(signedWithAnotherKey(current)).returning({ id: adminSession.id });
  logger.info(
    { businessEvent: 'auth.sessions.revoked_on_rotation', revoked: deleted.length },
    `revoked ${deleted.length} session(s) signed with another key`,
  );
  return deleted.length;
}
