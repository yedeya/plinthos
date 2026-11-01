/**
 * The offline-sync endpoint ([SYNC-1] to [SYNC-4]): `POST /admin/api/sync` with a batch of the
 * mutations the admin's device queued, answered with one outcome for each, in the batch's order.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous or cross-origin request before the
 * body is read ([AUTH-3], [AUTH-7]), and the replay gets the session's `AdminContext`. What
 * happens to each mutation is `src/server/sync/replay.ts`'s.
 */
import { adminRoute } from '../../../../server/auth/admin';
import { replayMutations, SyncBatch } from '../../../../server/sync/replay';

const noStore = { 'cache-control': 'no-store' } as const;

export const POST = adminRoute(async (request, { admin, requestId }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The body is not JSON.', requestId }, { status: 400, headers: noStore });
  }
  const batch = SyncBatch.safeParse(body);
  if (!batch.success) {
    return Response.json(
      { error: 'The body is not a batch of queued mutations.', issues: batch.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`), requestId },
      { status: 400, headers: noStore },
    );
  }
  return Response.json(await replayMutations(admin, batch.data), { headers: noStore });
});
