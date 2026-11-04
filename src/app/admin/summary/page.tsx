/**
 * `/admin/summary`: the printable catalogue ([EXP-5], #236, #255), behind the admin check
 * (`adminPage`, [AUTH-3]). Server-rendered from the catalogue as a publish would make it now
 * (`readCatalogueSummary`, through the projection's `readCatalogueData`), never from the database
 * directly, so it is safe to hand to a buyer: the summary first, then every item. The print
 * stylesheet (`../../admin.css`, `@media print`) hides the header and the **Print** button, keeps
 * each item's row on one page, and sets no page margin, so Chrome and Edge print no header or
 * footer with the admin's address. The document title, which a saved PDF is named after, says
 * what it is and when it was made (`printDocumentTitle`).
 */
import { adminPage } from '../../../server/auth/admin';
import { readCatalogueSummary } from '../../../server/export/export';
import { CatalogueSummary, printDocumentTitle } from '../../_admin/catalogue-summary';
import { Header, Page } from '../../_admin/chrome';
import { DocumentTitle } from '../../_admin/document-title';
import { PrintButton } from '../../_admin/print-button';
import { en } from '../../messages/en';

export const dynamic = 'force-dynamic';

export default adminPage(
  async ({ admin }) => {
    const data = await readCatalogueSummary(admin, {});
    return (
      <Page>
        <DocumentTitle title={printDocumentTitle(data.publishedAt)} />
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
