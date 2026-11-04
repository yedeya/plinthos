/**
 * `GET /admin/api/photos/covers/{itemId}`: an item's cover thumbnail for the printable catalogue
 * ([EXP-5], #255), as a redirect to a presigned GET of its stored size, valid for 10 minutes
 * ([PHOTO-6]). The page names only the item's id, which the catalogue publishes anyway, so neither
 * a stored key nor a snapshot path is in its HTML. An item with no photo, or an id that is not
 * one, answers 404.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous request before anything runs, without
 * the database ([AUTH-3], [AUTH-6]). No cache keeps the redirect: the presigned address expires.
 */
import { adminRoute } from '../../../../../../server/auth/admin';
import { CoverThumbnailInput, presignCoverThumbnail } from '../../../../../../server/photos/photos';

export const GET = adminRoute<{ readonly itemId: string }>(async (_request, { admin, params }) => {
  const input = CoverThumbnailInput.safeParse({ itemId: (await params).itemId });
  const url = input.success ? await presignCoverThumbnail(admin, input.data) : null;
  if (url === null) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
});

