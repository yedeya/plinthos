/**
 * The admin's failed-request path ([OPS-5]): when its server code fails a request, one error line
 * with the `businessEvent` `admin.request.failed` and a request id, and a page or response that
 * names the same id, so the owner can find the line in the server function's log group.
 *
 * Every request gets its own id, a fresh UUID, in the wrappers every admin route is built with
 * (`src/server/auth/admin.ts`):
 * - `adminRoute` answers a Route Handler's failure itself, with `failedRequestResponse`: a 500
 *   whose body and `x-request-id` header name the id.
 * - `adminPage` and `adminAction` log a page's or a Server Action's failure under the id, then
 *   rethrow the error with the id as its digest (`tagFailure`). Next.js keeps a digest an error
 *   already has and hands it to the error page (`src/app/error.tsx`), which names it.
 *
 * `reportRequestError` is what `src/instrumentation.ts` hands Next.js's `onRequestError`, which
 * sees every failure that escapes a page, a Server Action or a Route Handler. An error a wrapper
 * has already logged is not logged again. Anything else, such as a failure in a nested component
 * the page wrapper does not reach, is logged under the error's digest, which the error page shows;
 * Next.js computes that digest from the error's message and stack, so it may be shared by two
 * requests that failed the same way, and the lines' times tell them apart.
 *
 * Nothing here logs the query string or a header: either can carry a credential.
 */
import { randomUUID } from 'node:crypto';
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

/** Errors already logged by a wrapper, so `onRequestError` does not log them a second time. */
const logged = new WeakSet<object>();

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
  if (typeof error === 'object' && error !== null) logged.add(error);
  return requestId;
}

/** The 500 a Route Handler answers a failure with: its body and header name the request id. */
export function failedRequestResponse(requestId: string): Response {
  return Response.json(
    { error: `The request failed. Its request id is ${requestId}.`, requestId },
    { status: 500, headers: { 'cache-control': 'no-store', [REQUEST_ID_HEADER]: requestId } },
  );
}

/**
 * Gives a logged failure the request's id as its digest, so the error page names it, and returns
 * the error to rethrow. A thrown value that is not an object is wrapped in an `Error` first.
 */
export function tagFailure(error: unknown, requestId: string): Error {
  const tagged = error instanceof Error ? error : new Error(String(error));
  Object.assign(tagged, { digest: requestId });
  logged.add(tagged);
  return tagged;
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

/**
 * Logs a failure Next.js reports, under the digest the error page shows ([OPS-5]), unless a
 * wrapper has logged it already. Returns the id the error page names.
 */
export function reportRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
  log: Logger = logger,
): string {
  const digest = digestOf(error);
  if (digest !== undefined && typeof error === 'object' && error !== null && logged.has(error)) return digest;
  return logFailedRequest(
    error,
    { method: request.method, path: request.path, requestId: digest, route: context.routePath, routeType: context.routeType },
    log,
  );
}

function digestOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('digest' in error)) return undefined;
  const { digest } = error as { digest: unknown };
  return typeof digest === 'string' && digest !== '' ? digest : undefined;
}
