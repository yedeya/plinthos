/**
 * `GET /admin/export/full`: the **full** preset ([EXP-3]): every item with every field the owner entered, private ones included. The owner's own record: never published, linked from the catalogue or cached.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous request before anything runs, without
 * the database ([EXP-1], [AUTH-3], [AUTH-6]). The answer is a download that no cache keeps.
 */
import { adminRoute } from '../../../../server/auth/admin';
import { exportCollection } from '../../../../server/export/export';
import { csvDownload } from '../../../_admin/csv-download';

export const GET = adminRoute(async (_request, { admin }) => csvDownload(await exportCollection(admin, { preset: 'full' })));
