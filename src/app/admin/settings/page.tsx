/**
 * `/admin/settings`: the catalogue's settings, behind the admin check (`adminPage`, [AUTH-3]).
 * The intro and contact texts, each plain text up to 2,000 characters, with Save ([PUB-9]); the
 * catalogue's current address, shown only here, to the admin; and Rotate catalogue link, after a
 * confirmation that the old link stops working ([PUB-15]).
 */
import { adminPage } from '../../../server/auth/admin';
import { Header, Page } from '../../_admin/chrome';
import { readCatalogueSettings } from '../../_admin/settings-data';
import { CatalogueTextsForm, RotateLinkForm } from '../../_admin/settings-forms';
import { en } from '../../messages/en';
import { rotateLink, saveTexts } from '../actions';

export const dynamic = 'force-dynamic';

export default adminPage(
  async ({ admin }) => {
    const settings = await readCatalogueSettings(admin);
    return (
      <Page>
        <Header title={en.settings.title} back={{ href: '/admin', label: en.form.back }} />
        <CatalogueTextsForm action={saveTexts} introText={settings.introText} contactText={settings.contactText} maxText={settings.maxText} />
        <RotateLinkForm action={rotateLink} url={settings.url} />
      </Page>
    );
  },
  { path: '/admin/settings' },
);
