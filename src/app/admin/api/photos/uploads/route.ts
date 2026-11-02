/**
 * The presign route ([PHOTO-1], [PHOTO-7]): `POST /admin/api/photos/uploads` answers the phone's
 * queue with one presigned upload into the photo bucket's quarantine prefix, for a random key
 * the server makes, capped at the configured size and valid for 10 minutes.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous or cross-origin request before
 * anything is signed ([AUTH-3], [AUTH-7]). It reads nothing from the request and never touches
 * the database. What the phone does with the answer is `src/app/_offline/photos.ts`'s.
 */
import { adminRoute } from '../../../../../server/auth/admin';
import { presignPhotoUpload } from '../../../../../server/photos/photos';

export const POST = adminRoute(async (_request, { admin }) =>
  Response.json(await presignPhotoUpload(admin, {}), { headers: { 'cache-control': 'no-store' } }),
);
