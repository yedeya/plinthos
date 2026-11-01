/**
 * The admin's failed-request path ([OPS-5]): when its server code fails a request, one error line
 * with the `businessEvent` `admin.request.failed` and a request id, and a page that names the
 * same id, so the owner can find the line in the server function's log group.
 *
 * Two ways in, so a route that forgets one is still logged:
 * - `adminRoute` wraps a Route Handler. It answers a failure itself, with a 500 whose body and
 *   `x-request-id` header name a fresh request id.
 * - `reportRequestError` is what `src/instrumentation.ts` hands Next.js's `onRequestError`,
 *   which sees every failure that escapes a page, a server action or an unwrapped handler.
 *   Its request id is the error's digest, which Next.js gives the error page
 *   (`src/app/error.tsx`, `src/app/global-error.tsx`); an error without one gets a fresh id.
 *   Next.js computes the digest from the error's message and stack, so the same failure on two
 *   requests shares one id: the lines' times tell them apart.
 *
 * Neither logs the query string or a header: either can carry a credential.
 */
import { randomUUID } from 'node:crypto';
import { unstable_rethrow } from 'next/navigation';
import { logger, type Logger } from './logger';

/** The response header that names a failed request's id. */
export const REQUEST_ID_HEADER = 'x-request-id';

export interface FailedRequest {
  readonly method: string;
  /** The request's path. Anything from a `?` on is dropped before it is logged. */
  readonly path: string;
  /** The id the admin is shown. A fresh one is made when this is absent. */
  readonly requestId?: string;
  /** Next.js's name for the route that failed, such as `/admin/sets/[id]`. */
  readonly route?: string;
  /** What failed: `render`, `route`, `action` or `proxy`, as Next.js reports it. */
  readonly routeType?: string;
}

/** Logs one `admin.request.failed` line and returns the request id it names ([OPS-5]). */
export function logFailedRequest(error: unknown, request: FailedRequest, log: Logger = logger): string {
  const requestId = request.requestId ?? randomUUID();
  log.error(
    {
      businessEvent: 'admin.request.failed',
      requestId,
      method: request.method,
      path: request.path.split('?')[0],
      route: request.route,
      routeType: request.routeType,
      err: error instanceof Error ? error : new Error(String(error)),
    },
    'admin request failed',
  );
  return requestId;
}

/**
 * Wraps a Route Handler: a failure becomes one logged line and a 500 that names its request id.
 * Next.js's own control flow, `redirect()`, `notFound()` and the like, passes through untouched.
 */
export function adminRoute<Context>(
  handler: (request: Request, context: Context) => Response | Promise<Response>,
  log: Logger = logger,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      unstable_rethrow(error);
      const requestId = logFailedRequest(error, { method: request.method, path: new URL(request.url).pathname }, log);
      return Response.json(
        { error: `The request failed. Its request id is ${requestId}.`, requestId },
        { status: 500, headers: { 'cache-control': 'no-store', [REQUEST_ID_HEADER]: requestId } },
      );
    }
  };
}

/** Next.js's `onRequestError` arguments, as far as this path reads them. */
export interface RequestErrorRequest {
  readonly path: string;
  readonly method: string;
}
export interface RequestErrorContext {
  readonly routePath: string;
  readonly routeType: string;
}

/** Logs a failure Next.js reports, under the digest the error page shows ([OPS-5]). */
export function reportRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
  log: Logger = logger,
): string {
  return logFailedRequest(
    error,
    { method: request.method, path: request.path, requestId: digestOf(error), route: context.routePath, routeType: context.routeType },
    log,
  );
}

function digestOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return undefined;
  const { digest } = error as { digest: unknown };
  return typeof digest === 'string' && digest !== '' ? digest : undefined;
}
