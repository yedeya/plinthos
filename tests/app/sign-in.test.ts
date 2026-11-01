import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as login } from '../../src/app/auth/login/route';
import { POST as logout } from '../../src/app/admin/logout/route';
import AdminPage from '../../src/app/admin/page';
import { applyMigrations } from '../../src/db/migrate';
import { adminSession } from '../../src/db/schema';
import { LOGIN_PATH } from '../../src/server/auth/admin';
import { hashSessionId } from '../../src/server/auth/cookie';
import * as password from '../../src/server/auth/password';
import { LOGIN_LIMITS, VIEWER_ADDRESS_HEADER } from '../../src/server/auth/rate-limit';
import { logger } from '../../src/server/logger';
import { cookieSetBy, harness, sessionCookie } from '../support/admin-harness';
import {
  ADMIN_ORIGIN,
  memoryCounter,
  sameOrigin,
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  TEST_USERNAME,
  testAuthConfig,
  testHash,
} from '../support/auth';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';

vi.mock('../../src/server/database', async () => (await import('../support/admin-harness')).databaseMock);
vi.mock('../../src/server/auth/config', async (original) => ({
  ...(await original<typeof import('../../src/server/auth/config')>()),
  ...(await import('../support/admin-harness')).configMock,
}));
vi.mock('../../src/server/auth/login-attempts', async () => (await import('../support/admin-harness')).countersMock);
vi.mock('next/headers', async () => (await import('../support/admin-harness')).headersMock);
vi.mock('../../src/server/auth/password', async (original) => {
  const actual = await original<typeof import('../../src/server/auth/password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

/**
 * The sign-in end to end, through the real routes, against the test database: `[AUTH-2]`,
 * `[AUTH-6]` to `[AUTH-12]`. Only the configuration, the attempt counter and the request that
 * `cookies()` reads are stand-ins (`tests/support/admin-harness.ts`).
 */

const DAY = 24 * 60 * 60 * 1000;

let fresh: FreshDatabase;
let logged: unknown[][];

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  harness.db = fresh.db;
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(async () => {
  harness.config = await testAuthConfig();
  harness.counter = memoryCounter();
  harness.databaseCalls = 0;
  harness.request = new Headers(sameOrigin);
  logged = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => void logged.push([level, ...args]));
  }
  vi.mocked(password.verifyPassword).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function attempt(fields: { username?: string; password?: string } = {}, headers: Record<string, string> = sameOrigin, address = '192.0.2.10') {
  const body = new URLSearchParams({ username: fields.username ?? TEST_USERNAME, password: fields.password ?? TEST_PASSWORD });
  return login(
    new Request(`${ADMIN_ORIGIN}/auth/login`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', [VIEWER_ADDRESS_HEADER]: address, ...headers },
    }),
  );
}

async function signIn(): Promise<string> {
  const response = await attempt();
  expect(response.status).toBe(303);
  const value = cookieSetBy(response);
  if (value === undefined) throw new Error('the login set no session cookie');
  return value;
}

/** Whether the admin page lets this cookie in. */
async function pageAccepts(cookieValue: string): Promise<boolean> {
  harness.request = new Headers({ ...sameOrigin, cookie: sessionCookie(cookieValue) });
  try {
    await AdminPage({});
    return true;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT;') && digest.includes(LOGIN_PATH)) return false;
    throw error;
  }
}

const events = () => logged.map((call) => (call[1] as { businessEvent?: string } | undefined)?.businessEvent).filter(Boolean);

describe('the login', () => {
  it('[AUTH-8] signs the admin in with an HttpOnly, Secure, SameSite cookie, and stores only the hash of the session id', async () => {
    const response = await attempt();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin');
    const header = response.headers.get('set-cookie') ?? '';
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${30 * 24 * 60 * 60}`]) expect(header).toContain(attribute);
    const value = cookieSetBy(response) ?? '';
    const [sessionId] = value.split('.');
    const rows = await fresh.db.select().from(adminSession).where(eq(adminSession.idHash, hashSessionId(sessionId ?? '')));
    expect(rows).toHaveLength(1);
    const { rows: raw } = await fresh.client.query('select * from admin_session');
    expect(JSON.stringify(raw)).not.toContain(sessionId);
    expect(events()).toContain('auth.login.succeeded');
    expect(await pageAccepts(value)).toBe(true);
  });

  it('[AUTH-2] [AUTH-6] refuses a wrong password or username without calling the database, and logs auth.login.failed', async () => {
    for (const fields of [{ password: `${TEST_PASSWORD}-wrong` }, { username: 'made-up-someone-else' }, { password: '' }, { username: '' }]) {
      harness.databaseCalls = 0;
      const response = await attempt(fields);
      expect(response.status, JSON.stringify(fields)).toBe(303);
      expect(response.headers.get('location')).toBe('/login?failed=1');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(harness.databaseCalls, JSON.stringify(fields)).toBe(0);
    }
    expect(events().filter((event) => event === 'auth.login.failed')).toHaveLength(4);
  });

  it('[AUTH-2] runs scrypt even when the username is wrong, so timing does not tell which was', async () => {
    await attempt({ username: 'made-up-someone-else' });
    expect(password.verifyPassword).toHaveBeenCalledOnce();
  });

  it('[AUTH-2] never logs or returns the password', async () => {
    const wrong = `${TEST_PASSWORD}-made-up-wrong`;
    const failed = await attempt({ password: wrong });
    const succeeded = await attempt();
    const output = JSON.stringify(logged) + (await failed.text()) + (await succeeded.text()) + JSON.stringify([...failed.headers, ...succeeded.headers]);
    for (const secret of [TEST_PASSWORD, wrong]) expect(output).not.toContain(secret);
  });

  it('[AUTH-12] [AUTH-6] once an address passes its limit, refuses with 429 and Retry-After, without checking the password or calling the database', async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAddress; i++) await attempt({ password: 'made-up-guess' });
    vi.mocked(password.verifyPassword).mockClear();
    harness.databaseCalls = 0;
    const refused = await attempt();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(password.verifyPassword).not.toHaveBeenCalled();
    expect(harness.databaseCalls).toBe(0);
    expect(events()).toContain('auth.login.rate_limited');
    // Another address is still let in: the limit is per address first.
    expect((await attempt({}, sameOrigin, '192.0.2.11')).status).toBe(303);
  });

  it('[AUTH-12] lets the address try again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 1, 12, 0, 0));
    for (let i = 0; i <= LOGIN_LIMITS.perAddress; i++) await attempt({ password: 'made-up-guess' });
    expect((await attempt()).status).toBe(429);
    vi.setSystemTime(Date.UTC(2026, 10, 1, 12, 0, 0) + LOGIN_LIMITS.windowSeconds * 1000);
    expect((await attempt()).status).toBe(303);
  });

  it('[AUTH-7] refuses a login posted from another origin, before it counts or checks anything', async () => {
    const counter = memoryCounter();
    harness.counter = counter;
    for (const headers of [{ origin: 'https://evil.example.test', host: 'admin.example.test' }, { host: 'admin.example.test' }] as Record<string, string>[]) {
      const response = await attempt({}, headers);
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(counter.calls).toEqual([]);
    expect(harness.databaseCalls).toBe(0);
  });
});

describe('a session', () => {
  it('[AUTH-9] ends on the server at logout: the same cookie, replayed, is refused', async () => {
    const value = await signIn();
    expect(await pageAccepts(value)).toBe(true);
    const response = await logout(new Request(`${ADMIN_ORIGIN}/admin/logout`, { method: 'POST', headers: { ...sameOrigin, cookie: sessionCookie(value) } }), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(events()).toContain('auth.session.revoked');
    // The browser forgot it; an attacker who kept a copy replays it.
    expect(await pageAccepts(value)).toBe(false);
    const replay = await logout(new Request(`${ADMIN_ORIGIN}/admin/logout`, { method: 'POST', headers: { ...sameOrigin, cookie: sessionCookie(value) } }), {
      params: Promise.resolve({}),
    });
    expect(replay.status).toBe(401);
  });

  it('[AUTH-10] ends, with every other, when the password hash or the session secret changes and is deployed', async () => {
    const first = await signIn();
    const second = await signIn();
    expect(await pageAccepts(first)).toBe(true);
    harness.config = await testAuthConfig({ passwordHash: await testHash('made-up-new-password-0f3a9c') });
    harness.databaseCalls = 0;
    expect(await pageAccepts(first)).toBe(false);
    expect(await pageAccepts(second)).toBe(false);
    // Refused on the signature alone, so not even the database is asked.
    expect(harness.databaseCalls).toBe(0);

    harness.config = await testAuthConfig();
    const third = await signIn();
    harness.config = await testAuthConfig({ passwordHash: harness.config.passwordHashValue, sessionSecret: `${TEST_SESSION_SECRET}-rotated` });
    expect(await pageAccepts(third)).toBe(false);
  });

  it('[AUTH-11] ends once its idle lifetime has passed without a visit, and each visit restarts it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);
    vi.setSystemTime(t0);
    const kept = await signIn();
    const idle = await signIn();
    vi.setSystemTime(t0 + 6 * DAY);
    expect(await pageAccepts(kept)).toBe(true);
    vi.setSystemTime(t0 + 7 * DAY + 1000);
    expect(await pageAccepts(idle)).toBe(false);
    expect(await pageAccepts(kept)).toBe(true);
  });

  it('[AUTH-11] ends once its absolute lifetime has passed, however often it is used', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);
    vi.setSystemTime(t0);
    const value = await signIn();
    for (let day = 6; day < 30; day += 6) {
      vi.setSystemTime(t0 + day * DAY);
      expect(await pageAccepts(value), `day ${day}`).toBe(true);
    }
    vi.setSystemTime(t0 + 30 * DAY + 1000);
    expect(await pageAccepts(value)).toBe(false);
  });

  it('[AUTH-11] takes both lifetimes from the deployment’s configuration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);
    harness.config = await testAuthConfig({ idleDays: '1', absoluteDays: '2' });
    vi.setSystemTime(t0);
    const idle = await signIn();
    const active = await signIn();
    vi.setSystemTime(t0 + DAY - 1000);
    expect(await pageAccepts(active)).toBe(true);
    vi.setSystemTime(t0 + DAY + 1000);
    expect(await pageAccepts(idle)).toBe(false);
    expect(await pageAccepts(active)).toBe(true);
    vi.setSystemTime(t0 + 2 * DAY + 1000);
    expect(await pageAccepts(active)).toBe(false);
  });

  it('[AUTH-11] a sign-in clears the sessions that have ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2027, 0, 1, 12, 0, 0);
    vi.setSystemTime(t0);
    await signIn();
    vi.setSystemTime(t0 + 31 * DAY);
    await signIn();
    const { rows } = await fresh.client.query<{ n: number }>(
      `select count(*)::int as n from admin_session where created_at <= $1`,
      [new Date(t0 + 31 * DAY - 30 * DAY)],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
