/**
 * The check that a request came through the admin's CloudFront distribution ([AUTH-14], #61).
 *
 * The server function's own URL is open: SST's `protection` stays `none`, because plain OAC
 * needs every POST signed with its body's hash, which the login form can't do (`docs/deploy.md`).
 * A caller of that URL sets every header itself, the viewer's address the rate limiter counts
 * per included (`./rate-limit.ts`). So the distribution's viewer-request function also sets
 * `ORIGIN_HEADER`, overwriting any value the viewer sent, to `originSecret` of the linked
 * `SessionSecret` (`infra/admin.ts`). Only CloudFront and the server know it. `POST /auth/login`
 * refuses a request without it before anything else.
 *
 * The value is an HMAC, so it is no new secret to set and doesn't reveal `SessionSecret`, and
 * rotating `SessionSecret` rotates it. It sits in the CloudFront Function's code and in SST's
 * state, where anyone who can read the member account's resources can see it; a viewer never can.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ReadsHeaders } from './origin';

/** The header the admin's CloudFront distribution sets on every request (`infra/admin.ts`). */
export const ORIGIN_HEADER = 'x-plinthos-origin';

/** The header's value for a deployment: base64url, so it is quoted into the function's code as it is. */
export function originSecret(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('plinthos.origin.v1').digest('base64url');
}

/** Whether the request carries the header's value, compared in constant time. */
export function cameThroughCloudFront(headers: ReadsHeaders, sessionSecret: string): boolean {
  const given = headers.get(ORIGIN_HEADER);
  if (given === null) return false;
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(originSecret(sessionSecret)));
}
