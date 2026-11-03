/**
 * `/admin/summary`: the one-page printable summary ([EXP-5], #236), behind the admin check
 * (`adminPage`, [AUTH-3]). Server-rendered from the catalogue as a publish would make it now
 * (`readCatalogueSummary`, through the projection's `readCatalogueData`), never from the database
 * directly, so it is safe to hand to a buyer. The print stylesheet (`../../admin.css`, `@media
 * print`) keeps it to one A4 or Letter page and hides the header and the **Print** button.
 */
import { adminPage } from '../../../server/auth/admin';
import { readCatalogueSummary } from '../../../server/export/export';
import { CatalogueSummary } from '../../_admin/catalogue-summary';
import { Header, Page } from '../../_admin/chrome';
import { PrintButton } from '../../_admin/print-button';
import { en } from '../../messages/en';

export const dynamic = 'force-dynamic';

export default adminPage(
  async ({ admin }) => {
    const data = await readCatalogueSummary(admin, {});
    return (
      <Page>
        <div className="no-print">
          <Header title={en.summary.title} back={{ href: '/admin', label: en.form.back }} />
        </div>
        <CatalogueSummary data={data} />
        <div className="no-print summary__actions">
          <PrintButton />
        </div>
      </Page>
    );
  },
  { path: '/admin/summary' },
);
