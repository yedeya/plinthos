/**
 * Made-up sign-in configuration and stand-ins for the tests of `src/server/auth/`.
 *
 * Every value is invented for the tests. The password hash uses scrypt's smallest accepted cost
 * (N = 2^10) so the tests run fast; its parameters sit beside it, as in a real one.
 */
import { parseAuthConfig, type AuthConfig, type AuthSource } from '../../src/server/auth/config';
import { hashPassword } from '../../src/server/auth/password';
import type { AttemptCounter } from '../../src/server/auth/rate-limit';

export const TEST_USERNAME = 'made-up-admin';
export const TEST_PASSWORD = 'made-up-password-0f3a9c-long';
export const TEST_SESSION_SECRET = 'made-up-session-secret-0f3a9c-0123456789abcdef';

/** A cheap hash of `password`, for fixtures. */
export function testHash(password: string = TEST_PASSWORD): Promise<string> {
  return hashPassword(password, { ln: 10, r: 8, p: 1 });
}

/** A configuration from made-up values, with any of them replaced. */
export async function testAuthConfig(overrides: Partial<AuthSource> = {}): Promise<AuthConfig> {
  return parseAuthConfig({
    username: TEST_USERNAME,
    passwordHash: overrides.passwordHash ?? (await testHash()),
    sessionSecret: TEST_SESSION_SECRET,
    idleDays: undefined,
    absoluteDays: undefined,
    ...overrides,
  });
}

/** An in-memory attempt counter, which records each key it was asked to count. */
export function memoryCounter(): AttemptCounter & { readonly counts: Map<string, number>; readonly calls: string[] } {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  return {
    counts,
    calls,
    async increment(key) {
      calls.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

/** The admin's host in the tests, and the headers of a same-origin request to it. */
export const ADMIN_HOST = 'admin.example.test';
export const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
export const sameOrigin = { origin: ADMIN_ORIGIN, host: ADMIN_HOST, 'sec-fetch-site': 'same-origin' } as const;
