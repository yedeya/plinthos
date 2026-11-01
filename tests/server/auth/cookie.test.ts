import { describe, expect, it } from 'vitest';
import {
  clearSessionCookieHeader,
  hashSessionId,
  newSessionId,
  readSessionCookie,
  SESSION_COOKIE,
  SESSION_ID_BYTES,
  setSessionCookieHeader,
  signingKey,
  signSessionId,
  verifySessionCookie,
} from '../../../src/server/auth/cookie';
import { readRepoFile } from '../../support/repo-file';
import { TEST_SESSION_SECRET, TEST_USERNAME } from '../../support/auth';

const material = { sessionSecret: TEST_SESSION_SECRET, username: TEST_USERNAME, passwordHash: 'scrypt:made-up-hash-value' };
const key = signingKey(material);

describe('the session id', () => {
  it('[AUTH-8] holds at least 128 bits from the secure generator, and is never repeated', () => {
    expect(SESSION_ID_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(readRepoFile('src/server/auth/cookie.ts')).toMatch(/randomBytes\(SESSION_ID_BYTES\)/);
    const ids = new Set(Array.from({ length: 1000 }, newSessionId));
    expect(ids.size).toBe(1000);
    for (const id of [...ids].slice(0, 10)) expect(Buffer.from(id, 'base64url')).toHaveLength(SESSION_ID_BYTES);
  });

  it('[AUTH-8] is stored on the server only as its hash', () => {
    const id = newSessionId();
    expect(hashSessionId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionId(id)).not.toContain(id);
  });
});

describe('the session cookie', () => {
  it('[AUTH-8] carries only the signed id', () => {
    const id = newSessionId();
    const value = signSessionId(id, key);
    expect(value.split('.')).toHaveLength(2);
    expect(value.startsWith(`${id}.`)).toBe(true);
    expect(verifySessionCookie(value, key)).toBe(id);
  });

  it('[AUTH-8] is HttpOnly, Secure, SameSite and host-only', () => {
    const header = setSessionCookieHeader('v', 3600);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=3600']) expect(header).toContain(attribute);
    expect(header).not.toMatch(/Domain=/i);
    expect(clearSessionCookieHeader()).toMatch(/Max-Age=0/);
  });

  it('[AUTH-3] [AUTH-6] fails its check when forged, altered, truncated or signed with another key', () => {
    const id = newSessionId();
    const value = signSessionId(id, key);
    const other = signingKey({ ...material, sessionSecret: `${TEST_SESSION_SECRET}-other` });
    for (const bad of [
      '',
      id,
      `${id}.`,
      `${id}.${'A'.repeat(43)}`,
      `${newSessionId()}.${value.split('.')[1]}`,
      value.slice(0, -1),
      `${value}.extra`,
      signSessionId(id, other),
    ]) {
      expect(verifySessionCookie(bad, key), bad).toBeNull();
    }
    expect(verifySessionCookie(undefined, key)).toBeNull();
  });

  it('[AUTH-10] is signed with a key that changes when the password hash, the username or the session secret does', () => {
    const value = signSessionId(newSessionId(), key);
    for (const changed of [
      { ...material, passwordHash: 'scrypt:made-up-new-hash' },
      { ...material, username: 'made-up-other-admin' },
      { ...material, sessionSecret: `${TEST_SESSION_SECRET}-rotated` },
    ]) {
      expect(verifySessionCookie(value, signingKey(changed))).toBeNull();
    }
  });

  it('is found in a Cookie header among others', () => {
    expect(readSessionCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`)).toBe('abc.def');
    expect(readSessionCookie('a=1')).toBeUndefined();
    expect(readSessionCookie(null)).toBeUndefined();
  });
});
