/**
 * `GET /admin/export/buyer`: the **for a buyer** preset ([EXP-2]): the catalogue's public fields as a publish would make them now, built from the projection, with the value columns only when the settings show market values.
 *
 * It is an admin route, so `adminRoute` refuses an anonymous request before anything runs, without
 * the database ([EXP-1], [AUTH-3], [AUTH-6]). The answer is a download that no cache keeps.
 */
import { adminRoute } from '../../../../server/auth/admin';
import { exportCollection } from '../../../../server/export/export';
import { csvDownload } from '../../../_admin/csv-download';

export const GET = adminRoute(async (_request, { admin }) => csvDownload(await exportCollection(admin, { preset: 'buyer' })));
