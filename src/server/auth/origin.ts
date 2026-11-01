/**
 * The same-origin check on every state-changing request ([AUTH-7]): a request that changes
 * something must come from a page of the admin's own origin.
 *
 * Browsers send `Origin` with every POST, PUT, PATCH and DELETE, and a page of another site can't
 * forge it or the host it is compared with. The admin's own host is the one the browser asked
 * for: `x-forwarded-host`, which the admin's CloudFront distribution sets from the viewer's
 * `Host`, or else `Host`. This is the comparison Next.js makes for its own Server Actions; it is
 * made here too, so a Route Handler and a Server Action are held to the same rule. A request
 * without `Origin`, or whose `Sec-Fetch-Site` says it came from elsewhere, is refused.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The header-reading part of `Headers` that Next.js's `headers()` also offers. */
export interface ReadsHeaders {
  get(name: string): string | null;
}

/** Whether a request may proceed: a safe method always, any other only from the admin's origin. */
export function isSameOrigin(method: string, headers: ReadsHeaders): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') return false;
  const origin = headers.get('origin');
  if (origin === null || origin === 'null') return false;
  const host = (headers.get('x-forwarded-host') ?? headers.get('host'))?.split(',')[0]?.trim().toLowerCase();
  if (host === undefined || host === '') return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
