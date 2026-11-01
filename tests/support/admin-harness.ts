/**
 * What the admin's routes run against in the tests: the test database, a made-up sign-in
 * configuration, an in-memory attempt counter, and the request Next.js's `cookies()` and
 * `headers()` read. A test file wires it in with these mocks, before anything else:
 *
 *     vi.mock('../../src/server/database', async () => (await import('../support/admin-harness')).databaseMock);
 *     vi.mock('../../src/server/auth/config', async (original) => ({ ...(await original()), ...(await import('../support/admin-harness')).configMock }));
 *     vi.mock('../../src/server/auth/login-attempts', async () => (await import('../support/admin-harness')).countersMock);
 *     vi.mock('next/headers', async () => (await import('../support/admin-harness')).headersMock);
 *
 * `harness.databaseCalls` counts every call that reached for the database, which is how a test
 * proves a request never did ([AUTH-6]).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AuthConfig } from '../../src/server/auth/config';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';
import type { AttemptCounter } from '../../src/server/auth/rate-limit';
import { repoRoot } from './repo-file';

export const harness = {
  db: undefined as unknown,
  config: undefined as AuthConfig | undefined,
  counter: undefined as AttemptCounter | undefined,
  databaseCalls: 0,
  /** The request `cookies()` and `headers()` answer for: a page render or a Server Action. */
  request: new Headers(),
};

export const databaseMock = {
  database: () => {
    harness.databaseCalls++;
    if (harness.db === undefined) throw new Error('the test set no database');
    return harness.db;
  },
};

export const configMock = {
  authConfig: () => {
    if (harness.config === undefined) throw new Error('the test set no auth configuration');
    return harness.config;
  },
};

export const countersMock = {
  loginAttemptCounter: () => {
    if (harness.counter === undefined) throw new Error('the test set no attempt counter');
    return harness.counter;
  },
};

function cookieMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (harness.request.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) map.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return map;
}

export const headersMock = {
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieMap().get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => harness.request,
};

/** The `Cookie` header that carries a session cookie value. */
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}`;
}

/** The session cookie's value in a response's `Set-Cookie`, if it sets one. */
export function cookieSetBy(response: Response): string | undefined {
  const header = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header);
  return match?.[1] || undefined;
}

export interface AppRoute {
  /** The URL path, with route groups dropped, such as `/admin/logout`. */
  readonly path: string;
  /** The file, repository-relative. */
  readonly file: string;
  readonly kind: 'page' | 'route';
}

/** Every page and Route Handler under `src/app/`, from the files themselves. */
export function appRoutes(): AppRoute[] {
  const app = join(repoRoot, 'src', 'app');
  return readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(page|route)\.(tsx?|jsx?|mjs)$/.test(entry.name))
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      const segments = relative(app, entry.parentPath).split(sep).filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment));
      return { path: `/${segments.join('/')}`, file: relative(repoRoot, file), kind: entry.name.startsWith('page') ? 'page' : 'route' } as const;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Every module under `src/` that declares Server Actions with a `'use server'` directive. */
export function serverActionModules(): string[] {
  const src = join(repoRoot, 'src');
  return readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(tsx?|jsx?|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(repoRoot, file));
}

/** Whether a path is the admin's, behind the check. */
export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * The public allow-list ([AUTH-4]): the login and `/health/live`. The web app manifest, the
 * service worker, `/offline` and the static assets join it with #21; the static build assets are
 * not routes of `src/app/`.
 */
export const PUBLIC_ROUTES = ['/auth/login', '/health/live', '/login'] as const;

/** The HTTP methods a Route Handler module may export. */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
