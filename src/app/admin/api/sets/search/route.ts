/**
 * The set search ([CAT-1], [CAT-5]): `GET /admin/api/sets/search?q=` answers the entry form with
 * at most 10 sets matching a set number or a name, as `{ status: 'ok', sets }`, or with
 * `{ status: 'unavailable' }` when the set catalogue can't answer, so the form says so and still
 * takes a typed set number. A query shorter than two characters answers an empty list and asks
 * nothing.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous request before anything runs: it
 * touches neither the database nor Rebrickable for one ([AUTH-3], [AUTH-6]). Its answer is never
 * cached. A request the browser aborts, because the owner typed on, stops queuing calls to
 * Rebrickable behind the per-instance limiter ([CAT-2]).
 */
import { adminRoute } from '../../../../../server/auth/admin';
import { searchSets } from '../../../../../server/catalogue/sets';

export const GET = adminRoute(async (request, { admin }) => {
  const query = new URL(request.url).searchParams.get('q') ?? '';
  // The request's signal: a search the browser aborted for newer text stops asking Rebrickable.
  return Response.json(await searchSets(admin, query, { signal: request.signal }), { headers: { 'cache-control': 'no-store' } });
});
