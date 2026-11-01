/**
 * The admin check, as the three wrappers every admin route is built with ([AUTH-3], [AUTH-5]):
 *
 * - `adminRoute` for a Route Handler under `src/app/admin/`,
 * - `adminPage` for a page under `src/app/admin/`,
 * - `adminAction` for a Server Action.
 *
 * Each one runs in the route's own server code, never in middleware: it gives the request its
 * own id, checks a state-changing request's origin ([AUTH-7]), checks the session cookie's
 * signature and then the session itself (`./sessions.ts`), and only then runs the handler with
 * the `AdminContext` the check issued. A request with no cookie, or with a cookie whose signature
 * fails, is refused before the database is called ([AUTH-6]). A failure is logged once as
 * `admin.request.failed` under the request's id, and the response or the error page names that
 * id ([OPS-5]). `tests/app/admin-routes.test.ts` lists every route and holds each to this.
 */
import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import type { ReactNode } from 'react';
import { logger, type Logger } from '../logger';
import { failedRequestResponse, logFailedRequest, tagFailure } from '../request-failure';
import type { AdminContext } from './admin-context';
import { readSessionCookie, SESSION_COOKIE } from './cookie';
import { isSameOrigin } from './origin';
import { authenticate } from './sessions';

/** Where an anonymous page request is sent. */
export const LOGIN_PATH = '/login';

/** The property each wrapper marks the function it returns with, which the route test reads. */
export const ADMIN_GUARD = Symbol.for('plinthos.adminGuard');
export type AdminGuardKind = 'route' | 'page' | 'action';

function mark<F extends object>(fn: F, kind: AdminGuardKind): F {
  Object.defineProperty(fn, ADMIN_GUARD, { value: kind, enumerable: false });
  return fn;
}

/** What `adminRoute`'s handler receives beside the request. */
export interface AdminRouteContext<Params> {
  readonly admin: AdminContext;
  /** The route's dynamic segments, as Next.js passes them. */
  readonly params: Promise<Params>;
  readonly requestId: string;
}

/** A Route Handler as Next.js calls it. */
export type RouteHandler<Params> = (request: Request, context: { params: Promise<Params> }) => Promise<Response>;

const noStore = { 'cache-control': 'no-store' } as const;

/** The JSON refusal a Route Handler answers an unauthorized request with. */
function refusal(status: 401 | 403, error: string, requestId: string): Response {
  return Response.json({ error, requestId }, { status, headers: noStore });
}

/**
 * Wraps an admin Route Handler. An anonymous request, or one whose cookie fails its check, gets
 * 401; a state-changing request from another origin gets 403; neither runs the handler.
 */
export function adminRoute<Params = Record<string, never>>(
  handler: (request: Request, context: AdminRouteContext<Params>) => Response | Promise<Response>,
  options: { readonly log?: Logger } = {},
): RouteHandler<Params> {
  const log = options.log ?? logger;
  return mark(async (request: Request, context: { params: Promise<Params> }) => {
    const requestId = randomUUID();
    try {
      if (!isSameOrigin(request.method, request.headers)) {
        return refusal(403, 'This request did not come from the admin itself.', requestId);
      }
      const admin = await authenticate(readSessionCookie(request.headers.get('cookie')), requestId);
      if (admin === null) return refusal(401, 'Sign in first.', requestId);
      return await handler(request, { admin, params: context?.params ?? Promise.resolve({} as Params), requestId });
    } catch (error) {
      unstable_rethrow(error);
      logFailedRequest(error, { method: request.method, path: new URL(request.url).pathname, requestId, routeType: 'route' }, log);
      return failedRequestResponse(requestId);
    }
  }, 'route');
}

/**
 * Wraps an admin page. An anonymous visit is sent to `/login`. A failure inside the page is
 * logged under the request's own id, which becomes the error's digest, so the error page names
 * this request and no other ([OPS-5]).
 */
export function adminPage<Props extends object = Record<string, never>>(
  page: (props: Props & { readonly admin: AdminContext }) => ReactNode | Promise<ReactNode>,
  options: { readonly log?: Logger; readonly path?: string } = {},
): (props: Props) => Promise<ReactNode> {
  const log = options.log ?? logger;
  return mark(async (props: Props) => {
    const requestId = randomUUID();
    try {
      const admin = await authenticate((await cookies()).get(SESSION_COOKIE)?.value, requestId);
      if (admin === null) redirect(LOGIN_PATH);
      return await page({ ...props, admin });
    } catch (error) {
      unstable_rethrow(error);
      logFailedRequest(error, { method: 'GET', path: options.path ?? '(page)', requestId, routeType: 'render' }, log);
      throw tagFailure(error, requestId);
    }
  }, 'page');
}

/**
 * Wraps a Server Action. A call from another origin, or without a valid session, is refused
 * before the action runs; a failure is logged under the call's own id, which becomes the error's
 * digest the error page names ([OPS-5]).
 */
export function adminAction<Args extends unknown[], Result>(
  action: (admin: AdminContext, ...args: Args) => Promise<Result>,
  options: { readonly log?: Logger; readonly name?: string } = {},
): (...args: Args) => Promise<Result> {
  const log = options.log ?? logger;
  return mark(async (...args: Args) => {
    const requestId = randomUUID();
    try {
      if (!isSameOrigin('POST', await headers())) redirect(LOGIN_PATH);
      const admin = await authenticate((await cookies()).get(SESSION_COOKIE)?.value, requestId);
      if (admin === null) redirect(LOGIN_PATH);
      return await action(admin, ...args);
    } catch (error) {
      unstable_rethrow(error);
      logFailedRequest(error, { method: 'POST', path: options.name ?? '(action)', requestId, routeType: 'action' }, log);
      throw tagFailure(error, requestId);
    }
  }, 'action');
}
