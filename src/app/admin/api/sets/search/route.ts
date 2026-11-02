/**
 * The set search ([CAT-1], [CAT-5]): `GET /admin/api/sets/search?q=<set number or name>` answers
 * the entry form with `{ status: 'ok', sets }`, at most 10 sets, or `{ status: 'unavailable' }`
 * when the catalogue can't answer, never an error page.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous request before the database or
 * Rebrickable is reached ([AUTH-3], [AUTH-6]). What the search does is
 * `src/server/catalogue/sets.ts`'s.
 */
import { adminRoute } from '../../../../../server/auth/admin';
import { searchSets } from '../../../../../server/catalogue/sets';

export const GET = adminRoute(async (request, { admin }) => {
  const query = (new URL(request.url).searchParams.get('q') ?? '').slice(0, 200);
  return Response.json(await searchSets(admin, query), { headers: { 'cache-control': 'no-store' } });
});
