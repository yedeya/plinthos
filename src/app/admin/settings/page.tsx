/**
 * `/admin/settings`: the catalogue's settings, behind the admin check (`adminPage`, [AUTH-3]).
 * The intro and contact texts, each plain text up to 2,000 characters, with Save ([PUB-9]); the
 * catalogue's current address, shown only here, to the admin; and Rotate catalogue link, after a
 * confirmation that the old link stops working ([PUB-15]); and the values the catalogue shows,
 * Show values, selling mode, its display and the asking prices (#211, [PUB-17], [PUB-18]); and
 * the per-condition value adjustments, private to the admin (#207, [VAL-5]).
 */
import { adminPage } from '../../../server/auth/admin';
import { Header, Page } from '../../_admin/chrome';
import { readCatalogueSettings } from '../../_admin/settings-data';
import { CatalogueTextsForm, CatalogueValuesForm, RotateLinkForm, ValueAdjustmentsForm } from '../../_admin/settings-forms';
import { ADJUSTMENT_PCT_RANGE } from '../../../db/schema/catalogue-settings';
import { readValueAdjustments } from '../../../server/valuation/refresh';
import { en } from '../../messages/en';
import { rotateLink, saveAdjustments, saveTexts, saveValues } from '../actions';

export const dynamic = 'force-dynamic';

export default adminPage(
  async ({ admin }) => {
    const [settings, adjustments] = await Promise.all([readCatalogueSettings(admin), readValueAdjustments(admin)]);
    return (
      <Page>
        <Header title={en.settings.title} back={{ href: '/admin', label: en.form.back }} />
        <CatalogueTextsForm action={saveTexts} introText={settings.introText} contactText={settings.contactText} maxText={settings.maxText} />
        <CatalogueValuesForm action={saveValues} settings={settings.values} maxAskingPrice={settings.maxAskingPrice} />
        <ValueAdjustmentsForm action={saveAdjustments} usedWithBoxPct={adjustments.usedWithBoxPct} usedNoBoxPct={adjustments.usedNoBoxPct} range={ADJUSTMENT_PCT_RANGE} />
        <RotateLinkForm action={rotateLink} url={settings.url} />
      </Page>
    );
  },
  { path: '/admin/settings' },
);
