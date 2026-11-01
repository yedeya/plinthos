import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { notFound, redirect } from 'next/navigation';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '../../src/app/error';
import * as schema from '../../src/db/schema';
import { applyMigrations } from '../../src/db/migrate';
import { ADMIN_GUARD, adminAction, adminPage, adminRoute, LOGIN_PATH } from '../../src/server/auth/admin';
import { newSessionId, signingKey, signSessionId } from '../../src/server/auth/cookie';
import { startSession } from '../../src/server/auth/sessions';
import { REQUEST_ID_HEADER, reportRequestError } from '../../src/server/request-failure';
import {
  appRoutes,
  harness,
  HTTP_METHODS,
  inlineServerActions,
  isAdminPath,
  PUBLIC_ROUTES,
  segmentFiles,
  serverActionModules,
  sessionCookie,
} from '../support/admin-harness';
import { ADMIN_ORIGIN, memoryCounter, sameOrigin, testAuthConfig } from '../support/auth';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';
import { repoRoot } from '../support/repo-file';
import { captureLogger } from '../server/capture';

vi.mock('../../src/server/database', async () => (await import('../support/admin-harness')).databaseMock);
vi.mock('../../src/server/auth/config', async (original) => ({
  ...(await original<typeof import('../../src/server/auth/config')>()),
  ...(await import('../support/admin-harness')).configMock,
}));
vi.mock('../../src/server/auth/login-attempts', async () => (await import('../support/admin-harness')).countersMock);
vi.mock('next/headers', async () => (await import('../support/admin-harness')).headersMock);

/**
 * `[AUTH-3]` to `[AUTH-7]` and #42: every route of the app, listed from `src/app/`, is either on
 * the public allow-list or behind the admin check, and every admin route refuses an anonymous or
 * forged request before its handler runs and without calling the database. So does every layout,
 * template and other file that renders around an admin page, and no Server Action escapes its
 * wrapper by being declared inline (#59). `docs/qa/stack.md`'s `## Data isolation` holds this file.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  harness.db = fresh.db;
  harness.config = await testAuthConfig();
  harness.counter = memoryCounter();
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(() => {
  harness.databaseCalls = 0;
  harness.request = new Headers(sameOrigin);
});

const routes = appRoutes();
const adminRoutes = routes.filter((route) => isAdminPath(route.path));
const segments = segmentFiles();
const adminSegments = segments.filter((segment) => isAdminPath(segment.path));

/** The props Next.js renders a page, a layout or an error page with, empty. */
const renderProps = {
  children: null,
  params: Promise.resolve({}),
  searchParams: Promise.resolve({}),
  error: new Error('made-up failure'),
  reset: () => undefined,
};

/** The cookies an anonymous or forged request carries: none, or one that fails its signature. */
function forgedCookies(): (string | undefined)[] {
  const other = signingKey({ sessionSecret: 'made-up-attacker-secret-0f3a9c-0123456789', username: 'x', passwordHash: 'y' });
  return [
    undefined,
    sessionCookie('made-up-not-a-session'),
    sessionCookie(`${newSessionId()}.${'A'.repeat(43)}`),
    sessionCookie(signSessionId(newSessionId(), other)),
  ];
}

/** Each refused request's headers: every forged cookie, with and without the middleware-bypass header. */
function anonymousRequests(): Record<string, string>[] {
  return forgedCookies().flatMap((cookie) =>
    ([{}, { 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' }] as Record<string, string>[]).map((extra) => ({
      ...sameOrigin,
      ...extra,
      ...(cookie === undefined ? {} : { cookie }),
    })),
  );
}

async function loadModule(file: string): Promise<Record<string, unknown>> {
  return (await import(join(repoRoot, file))) as Record<string, unknown>;
}

function redirectTarget(error: unknown): string | undefined {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;') ? digest.split(';')[2] : undefined;
}

async function signedIn(): Promise<string> {
  const { cookieValue } = await startSession();
  return sessionCookie(cookieValue);
}

describe('every route of the app', () => {
  it('[AUTH-3] [AUTH-4] is found in src/app/, and the list is not empty', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(adminRoutes.length).toBeGreaterThan(0);
    expect(routes.map((route) => route.path)).toEqual(expect.arrayContaining([...PUBLIC_ROUTES, '/admin', '/admin/logout']));
  });

  it('[AUTH-4] is on the public allow-list by name or behind the admin check under /admin', () => {
    for (const route of routes) {
      expect((PUBLIC_ROUTES as readonly string[]).includes(route.path) || isAdminPath(route.path), `${route.file} is neither public nor an admin route`).toBe(true);
    }
  });

  it('[AUTH-1] holds no route that creates, claims or resets an admin account, and no table that stores one', () => {
    for (const route of routes) expect(route.path, route.file).not.toMatch(/setup|sign-?up|register|onboard|install|claim|reset|account|password|user/i);
    for (const table of Object.values(schema) as PgTable[]) {
      const config = getTableConfig(table);
      for (const column of config.columns) expect(`${config.name}.${column.name}`).not.toMatch(/user|password|email|admin_name/);
    }
  });

  it('[AUTH-5] has no middleware or proxy to stand in for the check: it runs in each route', () => {
    for (const file of ['middleware.ts', 'middleware.js', 'proxy.ts', 'proxy.js', 'src/middleware.ts', 'src/proxy.ts', 'src/middleware.js', 'src/proxy.js']) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false);
    }
  });
});

describe('every admin route', () => {
  it('[AUTH-3] [OPS-5] is built with the admin wrappers: each Route Handler method with adminRoute (#42), each page with adminPage', async () => {
    for (const route of adminRoutes) {
      // An icon, a shared image, a sitemap: Next.js serves it as a route that no wrapper fits.
      expect(route.kind, `${route.file} is a metadata file, served under /admin without the admin check`).not.toBe('metadata');
      if (route.kind === 'metadata') continue;
      const module = await loadModule(route.file);
      if (route.kind === 'page') {
        expect((module.default as Record<symbol, unknown> | undefined)?.[ADMIN_GUARD], route.file).toBe('page');
        continue;
      }
      const methods = HTTP_METHODS.filter((method) => method in module);
      expect(methods.length, route.file).toBeGreaterThan(0);
      for (const method of methods) {
        expect((module[method] as Record<symbol, unknown>)[ADMIN_GUARD], `${route.file} ${method}`).toBe('route');
      }
    }
  });

  it('[AUTH-3] [AUTH-6] exports no other function from an admin page, Route Handler or layout, such as generateMetadata, which Next.js runs outside the wrapper', async () => {
    const files = [...adminRoutes.filter((route) => route.kind !== 'metadata'), ...adminSegments];
    for (const { file, kind } of files) {
      const allowed: readonly string[] = kind === 'route' ? HTTP_METHODS : ['default'];
      const others = Object.entries(await loadModule(file)).filter(([name, value]) => typeof value === 'function' && !allowed.includes(name));
      expect(others.map(([name]) => name), file).toEqual([]);
    }
  });

  it("[AUTH-3] [AUTH-5] declares no inline Server Action, which adminAction can't wrap: 'use server' is only ever a module's directive", () => {
    expect(inlineServerActions()).toEqual([]);
  });

  it('[AUTH-3] [AUTH-5] every Server Action is built with adminAction', async () => {
    for (const file of serverActionModules()) {
      const module = await loadModule(file);
      for (const [name, value] of Object.entries(module)) {
        expect((value as Record<symbol, unknown>)[ADMIN_GUARD], `${file} ${name}`).toBe('action');
      }
    }
  });

  it('[AUTH-3] [AUTH-6] refuses, before its handler runs and without the database, a request with no cookie or a forged one, x-middleware-subrequest included', async () => {
    for (const route of adminRoutes) {
      if (route.kind === 'metadata') continue; // refused outright above
      const module = await loadModule(route.file);
      for (const headers of anonymousRequests()) {
        harness.databaseCalls = 0;
        if (route.kind === 'page') {
          harness.request = new Headers(headers);
          const page = module.default as (props: object) => Promise<unknown>;
          const error = await page({ params: Promise.resolve({}), searchParams: Promise.resolve({}) }).then(
            () => undefined,
            (thrown: unknown) => thrown,
          );
          expect(redirectTarget(error), `${route.file} ${JSON.stringify(headers)}`).toBe(LOGIN_PATH);
        } else {
          for (const method of HTTP_METHODS.filter((name) => name in module)) {
            const handler = module[method] as (request: Request, context: { params: Promise<object> }) => Promise<Response>;
            const response = await handler(new Request(`${ADMIN_ORIGIN}${route.path}`, { method, headers }), { params: Promise.resolve({}) });
            expect(response.status, `${route.file} ${method} ${JSON.stringify(headers)}`).toBe(401);
          }
        }
        expect(harness.databaseCalls, `${route.file} called the database`).toBe(0);
      }
    }
  });

  it('[AUTH-7] refuses a state-changing request from another origin, even with a valid session, before the database', async () => {
    const cookie = await signedIn();
    for (const route of adminRoutes.filter((r) => r.kind === 'route')) {
      const module = await loadModule(route.file);
      for (const method of HTTP_METHODS.filter((name) => name in module && !['GET', 'HEAD', 'OPTIONS'].includes(name))) {
        for (const headers of [{ origin: 'https://evil.example.test', host: 'admin.example.test', cookie }, { host: 'admin.example.test', cookie }] as Record<string, string>[]) {
          harness.databaseCalls = 0;
          const handler = module[method] as (request: Request, context: { params: Promise<object> }) => Promise<Response>;
          const response = await handler(new Request(`${ADMIN_ORIGIN}${route.path}`, { method, headers }), { params: Promise.resolve({}) });
          expect(response.status, `${route.file} ${method}`).toBe(403);
          expect(harness.databaseCalls).toBe(0);
        }
      }
    }
  });

  it('[AUTH-3] lets a request with a valid session through to its page', async () => {
    harness.request = new Headers({ ...sameOrigin, cookie: await signedIn() });
    const page = (await loadModule('src/app/admin/page.tsx')).default as (props: object) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
    const html = renderToStaticMarkup(await page({}));
    expect(html).toContain('You are signed in');
    expect(html).toContain('action="/admin/logout"');
  });
});

describe('every file that renders around a page', () => {
  it('[AUTH-3] [AUTH-6] is found in src/app/, the root layout among them', () => {
    expect(segments.map((segment) => segment.file)).toContain('src/app/layout.tsx');
  });

  it('[AUTH-3] [AUTH-6] under /admin, is built with adminPage, or is an error page and a Client Component', async () => {
    for (const segment of adminSegments) {
      if (segment.kind === 'error') {
        expect(segment.client, `${segment.file} is an error page that is not a Client Component`).toBe(true);
        continue;
      }
      const module = await loadModule(segment.file);
      expect((module.default as Record<symbol, unknown> | undefined)?.[ADMIN_GUARD], segment.file).toBe('page');
    }
  });

  it('[AUTH-3] [AUTH-6] under /admin, refuses a request with no cookie or a forged one before it renders, without the database', async () => {
    for (const segment of adminSegments.filter((s) => !s.client)) {
      const render = (await loadModule(segment.file)).default as (props: object) => Promise<unknown>;
      for (const headers of anonymousRequests()) {
        harness.databaseCalls = 0;
        harness.request = new Headers(headers);
        const error = await render(renderProps).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(redirectTarget(error), `${segment.file} ${JSON.stringify(headers)}`).toBe(LOGIN_PATH);
        expect(harness.databaseCalls, `${segment.file} called the database`).toBe(0);
      }
    }
  });

  it('[AUTH-6] renders a request with no cookie or a forged one without the database, outside /admin and as a Client Component', async () => {
    // Outside /admin a layout renders around the login and around the admin's pages alike, so it
    // can't refuse anyone: it must not reach for the database at all. Each exported function's
    // own body runs here; whatever it renders is a component of `src/`, held by its own route.
    for (const segment of segments.filter((s) => s.client || !isAdminPath(s.path))) {
      const module = await loadModule(segment.file);
      for (const headers of anonymousRequests()) {
        harness.databaseCalls = 0;
        harness.request = new Headers(headers);
        if (segment.client) {
          renderToStaticMarkup(createElement(module.default as (props: object) => ReturnType<typeof createElement>, renderProps));
        } else {
          for (const value of Object.values(module).filter((v): v is (props: object) => unknown => typeof v === 'function')) {
            await Promise.resolve(value(renderProps)).catch((thrown: unknown) => {
              if (redirectTarget(thrown) === undefined) throw thrown;
            });
          }
        }
        expect(harness.databaseCalls, `${segment.file} called the database`).toBe(0);
      }
    }
  });
});

describe('the admin wrappers', () => {
  it('[AUTH-3] [AUTH-5] adminRoute runs the handler only with an AdminContext from a valid session', async () => {
    let seen: unknown;
    const handler = adminRoute(async (_request, { admin, requestId }) => {
      seen = admin;
      return Response.json({ requestId });
    });
    const anonymous = await handler(new Request(`${ADMIN_ORIGIN}/admin/x`), { params: Promise.resolve({}) });
    expect(anonymous.status).toBe(401);
    expect(seen).toBeUndefined();
    const ok = await handler(new Request(`${ADMIN_ORIGIN}/admin/x`, { headers: { cookie: await signedIn() } }), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
    expect(seen).toMatchObject({ sessionKey: expect.stringMatching(UUID), requestId: expect.stringMatching(UUID) });
  });

  it('[OPS-5] adminRoute passes Next.js redirects and not-founds through without logging them', async () => {
    const { log, lines } = captureLogger();
    const cookie = await signedIn();
    const request = () => new Request(`${ADMIN_ORIGIN}/admin/x`, { headers: { cookie } });
    await expect(adminRoute(() => redirect('/elsewhere'), { log })(request(), { params: Promise.resolve({}) })).rejects.toThrow();
    await expect(adminRoute(() => notFound(), { log })(request(), { params: Promise.resolve({}) })).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it('[OPS-5] adminRoute answers a failure with a 500 that names the id the error line logs, a fresh one per request', async () => {
    const { log, events, lines } = captureLogger();
    const handler = adminRoute(() => {
      throw new Error('the handler broke');
    }, { log });
    const cookie = await signedIn();
    const first = await handler(new Request(`${ADMIN_ORIGIN}/admin/sets/42?token=made-up-query-token`, { headers: { cookie } }), { params: Promise.resolve({}) });
    const second = await handler(new Request(`${ADMIN_ORIGIN}/admin/sets/42`, { headers: { cookie } }), { params: Promise.resolve({}) });
    const [one, two] = events();
    expect(one).toMatchObject({ level: 'error', businessEvent: 'admin.request.failed', method: 'GET', path: '/admin/sets/42', routeType: 'route' });
    expect(one?.requestId).toMatch(UUID);
    expect(first.status).toBe(500);
    expect(first.headers.get(REQUEST_ID_HEADER)).toBe(one?.requestId);
    expect(((await first.json()) as { requestId: string }).requestId).toBe(one?.requestId);
    expect(second.headers.get(REQUEST_ID_HEADER)).toBe(two?.requestId);
    expect(one?.requestId).not.toBe(two?.requestId);
    const output = lines.join('');
    for (const secret of ['made-up-query-token', cookie]) expect(output).not.toContain(secret);
  });

  it('[OPS-5] adminPage logs a failure under its own request id, which becomes the digest the error page names, logged once', async () => {
    const { log, events } = captureLogger();
    const page = adminPage(async () => {
      throw new Error('the page broke');
    }, { log, path: '/admin/broken' });
    harness.request = new Headers({ ...sameOrigin, cookie: await signedIn() });
    const errors = [];
    for (let i = 0; i < 2; i++) errors.push(await page({}).then(() => undefined, (thrown: unknown) => thrown as Error & { digest?: string }));
    const [first, second] = errors;
    const [one, two] = events();
    expect(one).toMatchObject({ businessEvent: 'admin.request.failed', path: '/admin/broken', routeType: 'render' });
    expect(one?.requestId).toMatch(UUID);
    expect(first?.digest).toBe(one?.requestId);
    expect(second?.digest).toBe(two?.requestId);
    expect(first?.digest).not.toBe(second?.digest);

    // Next.js then reports the same error: it is not logged a second time, under the same id.
    expect(reportRequestError(first, { path: '/admin/broken', method: 'GET' }, { routePath: '/admin/broken', routeType: 'render' }, log)).toBe(first?.digest);
    expect(events()).toHaveLength(2);

    const html = renderToStaticMarkup(createElement(ErrorPage, { error: first as Error, reset: () => undefined }));
    expect(html).toContain(`<code>${String(first?.digest)}</code>`);
    expect(html).not.toContain('the page broke');
  });

  it('[AUTH-3] [AUTH-7] [OPS-5] adminAction refuses an anonymous or cross-origin call, and logs a failure under its own id', async () => {
    const { log, events } = captureLogger();
    let ran = 0;
    const action = adminAction(async (admin, value: string) => {
      ran++;
      if (value === 'break') throw new Error('the action broke');
      return `${value}:${admin.requestId === undefined ? 'no' : 'yes'}`;
    }, { log, name: 'example' });

    harness.request = new Headers(sameOrigin);
    expect(redirectTarget(await action('x').catch((e: unknown) => e))).toBe(LOGIN_PATH);
    const cookie = await signedIn();
    harness.request = new Headers({ origin: 'https://evil.example.test', host: 'admin.example.test', cookie });
    expect(redirectTarget(await action('x').catch((e: unknown) => e))).toBe(LOGIN_PATH);
    expect(ran).toBe(0);

    harness.request = new Headers({ ...sameOrigin, cookie });
    expect(await action('x')).toBe('x:yes');
    const failure = (await action('break').catch((e: unknown) => e)) as { digest?: string };
    expect(events()[0]).toMatchObject({ businessEvent: 'admin.request.failed', routeType: 'action', requestId: failure.digest });
    expect(failure.digest).toMatch(UUID);
  });
});
