/**
 * The parts file's presign route ([PARTS-2]): `POST /admin/api/parts/uploads` answers
 * `/admin/parts` with one presigned upload into the photo bucket's private `imports/` prefix, for
 * a random key the server makes, capped at `PLINTHOS_PARTS_MAX_BYTES` and valid for 10 minutes.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous or cross-origin request before
 * anything is signed ([AUTH-3], [AUTH-7]). It reads nothing from the request and never touches
 * the database. The page then posts the file straight to S3 and calls `importParts`
 * (`../../../actions.ts`), which reads, parses and deletes it.
 */
import { adminRoute } from '../../../../../server/auth/admin';
import { presignPartsUpload } from '../../../../../server/parts/parts';

export const POST = adminRoute(async (_request, { admin }) =>
  Response.json(await presignPartsUpload(admin, {}), { headers: { 'cache-control': 'no-store' } }),
);
