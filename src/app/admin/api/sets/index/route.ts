/**
 * The set index ([CAT-9], brief #252): `GET /admin/api/sets/index` answers the entry form with the
 * current index, gzipped as it is stored, with its version as the `ETag`; `304` to an
 * `If-None-Match` that names the current version, so the phone's check is one conditional
 * request; and `404` while no index has been built. Every answer is `no-store`.
 *
 * The body is the gzip file itself, as `application/gzip` with no `Content-Encoding`, so no layer
 * decompresses it or compresses it again, and the device inflates it once it has all of it.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous request before anything runs: it
 * touches neither the database nor the bucket for one ([AUTH-3], [AUTH-6]).
 */
import { adminRoute } from '../../../../../server/auth/admin';
import { setIndexFile } from '../../../../../server/catalogue/set-index/file';

export const GET = adminRoute(async (request, { admin }) => {
  const answer = await setIndexFile(admin, { ifNoneMatch: request.headers.get('if-none-match') });
  if (answer.status === 'missing') return new Response('No set index has been built yet.', { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
  const headers = { 'cache-control': 'no-store', etag: `"${answer.version}"` };
  if (answer.status === 'not-modified') return new Response(null, { status: 304, headers });
  // A copy over its own ArrayBuffer, which is what a body takes: about 640 KB.
  return new Response(new Uint8Array(answer.body), { status: 200, headers: { ...headers, 'content-type': 'application/gzip', 'content-length': String(answer.body.byteLength) } });
});
