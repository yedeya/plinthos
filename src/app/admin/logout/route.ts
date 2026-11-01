/**
 * `POST /admin/logout`: ends the admin's session on the server, so the same cookie replayed
 * afterwards is refused ([AUTH-9]), clears the cookie and goes back to `/login`. Behind the
 * admin check and the origin check (`adminRoute`, [AUTH-3], [AUTH-7]).
 */
import { adminRoute } from '../../../server/auth/admin';
import { clearSessionCookieHeader } from '../../../server/auth/cookie';
import { endSession } from '../../../server/auth/sessions';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (_request, { admin }) => {
  await endSession(admin);
  return new Response(null, {
    status: 303,
    headers: { 'cache-control': 'no-store', location: '/login', 'set-cookie': clearSessionCookieHeader() },
  });
});
