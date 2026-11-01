/**
 * The session cookie ([AUTH-8]): it carries only the session id and its signature, and it is
 * `HttpOnly`, `Secure`, `SameSite=Strict` and host-only (the `__Host-` prefix).
 *
 * The id is 32 bytes from `randomBytes`, 256 bits. The database holds its SHA-256, never the id
 * (`admin_session.id_hash`). The signature is an HMAC-SHA256 under a key derived from the
 * `SessionSecret`, the admin's username and the admin's password hash, so changing any of the
 * three in the deployment's configuration makes every cookie issued before fail its signature:
 * every earlier session ends, and it is refused without calling the database ([AUTH-10],
 * [AUTH-6]). Its row is deleted too, by the deploy's sweep or the next sign-in, so setting the
 * earlier value again does not bring it back (`keyFingerprint`).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The cookie's name. `__Host-` makes a browser refuse it unless it is `Secure`, on `/`, with no `Domain`. */
export const SESSION_COOKIE = '__Host-plinthos_session';

/** Bytes of randomness in a session id: 256 bits, twice what [AUTH-8] asks. */
export const SESSION_ID_BYTES = 32;

const ID = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/** What the signing key is derived from: all of it is the deployment's configuration. */
export interface SigningMaterial {
  readonly sessionSecret: string;
  readonly username: string;
  readonly passwordHash: string;
}

/** The key cookies are signed with, derived so that a credential change ends every session. */
export function signingKey({ sessionSecret, username, passwordHash }: SigningMaterial): Buffer {
  return createHmac('sha256', sessionSecret).update(`plinthos.session.v1\0${username}\0${passwordHash}`).digest();
}

/**
 * What a session's row stores to name the key that signed its cookie, in hex: an HMAC under the
 * key, so the table never yields the key. A session matches only while its key is the current
 * one, and a sweep deletes the rows of every other key, so returning a credential to an earlier
 * value never revives a session its change ended (`./sessions.ts`, [AUTH-10]).
 */
export function keyFingerprint(key: Buffer): string {
  return createHmac('sha256', key).update('plinthos.session.fingerprint.v1').digest('hex');
}

/** A new session id, from the operating system's secure generator. */
export function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

/** What the database stores for a session id: its SHA-256, in hex. */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

function sign(sessionId: string, key: Buffer): string {
  return createHmac('sha256', key).update(sessionId).digest('base64url');
}

/** The cookie's value: the id and its signature. */
export function signSessionId(sessionId: string, key: Buffer): string {
  return `${sessionId}.${sign(sessionId, key)}`;
}

/** The session id a cookie value carries, or null when its form or its signature is wrong. */
export function verifySessionCookie(value: string | undefined, key: Buffer): string | null {
  if (value === undefined) return null;
  const [id, signature, ...rest] = value.split('.');
  if (id === undefined || signature === undefined || rest.length > 0 || !ID.test(id) || !SIGNATURE.test(signature)) return null;
  const expected = Buffer.from(sign(id, key));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

/** The session cookie's value in a `Cookie` request header, if it has one. */
export function readSessionCookie(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** A `Set-Cookie` header value that sets the session cookie. */
export function setSessionCookieHeader(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Strict`;
}

/** A `Set-Cookie` header value that removes the session cookie. */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
