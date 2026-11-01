/**
 * `/health/live`: the liveness probe the deploy's smoke check calls ([PLAT-4]).
 *
 * It answers from the server function alone. It imports nothing that reaches the database, so a
 * probe never wakes a paused Aurora cluster and still answers when the database is unreachable
 * ([PLAT-14], AGENTS.md §3). `tests/app/health-live.test.ts` holds it to that, imports included.
 */

// Rendered on every request, so a 200 proves the server function runs, not a cached copy.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
