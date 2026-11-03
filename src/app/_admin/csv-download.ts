/**
 * The answer of the export's two downloads (`/admin/export/buyer`, `/admin/export/full`, [EXP-1]):
 * the file as an attachment under its name, as UTF-8 CSV, which no cache keeps.
 */
import type { ExportedFile } from '../../server/export/export';

export function csvDownload(file: ExportedFile): Response {
  return new Response(file.csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // The name is ours, `plinthos-{preset}-YYYY-MM-DD.csv`: nothing in it needs quoting or encoding.
      'content-disposition': `attachment; filename="${file.fileName}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
