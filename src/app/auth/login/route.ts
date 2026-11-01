/**
 * `POST /auth/login`: the login form's target, on the public allow-list ([AUTH-4]).
 *
 * A request that did not come through the admin's CloudFront distribution is refused with 403
 * before anything else, so a caller of the server function's own URL can't choose the address the
 * rate limiter counts it under ([AUTH-14], `src/server/auth/via-cloudfront.ts`). A request from
 * another origin is refused with 403 too ([AUTH-7]). Otherwise `signIn` decides
 * (`src/server/auth/sign-in.ts`): a rate-limited attempt gets 429 with `Retry-After`, unchecked
 * ([AUTH-12]); a wrong username or password goes back to the form; a match sets the session
 * cookie and goes to `/admin`. A failure is logged with its request id, which the 500 names
 * ([OPS-5]).
 */
import { randomUUID } from 'node:crypto';
import { authConfig } from '../../../server/auth/config';
import { setSessionCookieHeader } from '../../../server/auth/cookie';
import { isSameOrigin } from '../../../server/auth/origin';
import { VIEWER_ADDRESS_HEADER } from '../../../server/auth/rate-limit';
import { signIn } from '../../../server/auth/sign-in';
import { cameThroughCloudFront } from '../../../server/auth/via-cloudfront';
import { logger } from '../../../server/logger';
import { failedRequestResponse, logFailedRequest } from '../../../server/request-failure';

export const dynamic = 'force-dynamic';

const noStore = { 'cache-control': 'no-store' } as const;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (!cameThroughCloudFront(request.headers, authConfig().sessionSecret)) {
      logger.warn({ businessEvent: 'auth.login.not_via_cloudfront', requestId }, 'a login attempt did not come through CloudFront');
      return new Response('Sign in through the admin’s own address.', { status: 403, headers: noStore });
    }
    if (!isSameOrigin(request.method, request.headers)) {
      return new Response('This sign-in did not come from the admin’s own page.', { status: 403, headers: noStore });
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      form = new FormData();
    }
    const result = await signIn(
      {
        username: text(form, 'username'),
        password: text(form, 'password'),
        clientAddress: request.headers.get(VIEWER_ADDRESS_HEADER)?.trim() || 'unknown',
      },
      { requestId },
    );
    switch (result.outcome) {
      case 'rate-limited':
        return new Response('Too many sign-in attempts. Wait a few minutes, then try again.', {
          status: 429,
          headers: { ...noStore, 'retry-after': String(result.retryAfterSeconds) },
        });
      case 'refused':
        return new Response(null, { status: 303, headers: { ...noStore, location: '/login?failed=1' } });
      case 'signed-in':
        return new Response(null, {
          status: 303,
          headers: { ...noStore, location: '/admin', 'set-cookie': setSessionCookieHeader(result.cookieValue, result.maxAgeSeconds) },
        });
    }
  } catch (error) {
    logFailedRequest(error, { method: request.method, path: new URL(request.url).pathname, requestId, routeType: 'route' });
    return failedRequestResponse(requestId);
  }
}
