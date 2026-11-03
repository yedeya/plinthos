/**
 * `/admin/items/[id]`: an item in the entry form, to edit online or delete ([ITEM-9]), behind the
 * admin check (`adminPage`, [AUTH-3]). It opens with the item the server holds and its version, so
 * a stale edit meets the conflict rule when it syncs ([ITEM-3]). An id that is not a UUID, or that
 * no item has, is a not-found. Under the form is the item's value and its private override (#207,
 * [VAL-7]), saved online through the guarded `saveOverride`, apart from the item's version.
 */
import { notFound } from 'next/navigation';
import { adminPage } from '../../../../server/auth/admin';
import { photoSettings } from '../../../../server/photos/config';
import { Header, Page } from '../../../_admin/chrome';
import { EntryForm } from '../../../_admin/entry-form';
import { getItem } from '../../../_admin/item-data';
import { ValueOverrideForm } from '../../../_admin/values';
import { MAX_VALUE_OVERRIDE } from '../../../../db/schema/collection-item';
import { readAdminValues } from '../../../../server/valuation/refresh';
import { deploymentCurrency } from '../../../../server/valuation/values';
import { QueueSync } from '../../../_offline/client';
import { en } from '../../../messages/en';
import { saveOverride } from '../../actions';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default adminPage<{ readonly params: Promise<{ readonly id?: string }> }>(
  async ({ admin, params }) => {
    const { id } = await params;
    if (id === undefined || !UUID.test(id)) notFound();
    const [item, valued] = await Promise.all([getItem(admin, id), readAdminValues(admin)]);
    if (item === null) notFound();
    const current = valued.values.items.get(item.id) ?? null;
    return (
      <Page>
        <Header title={en.form.editTitle} back={{ href: '/admin', label: en.form.back }} />
        <EntryForm mode="edit" item={item} longestEdge={photoSettings().longestEdge} />
        <ValueOverrideForm
          action={saveOverride.bind(null, item.id)}
          amount={current?.source === 'override' ? current.amount : null}
          currency={current?.source === 'override' ? current.currency : deploymentCurrency()}
          quantity={item.quantity}
          maxAmount={MAX_VALUE_OVERRIDE}
          current={current}
        />
        <QueueSync />
      </Page>
    );
  },
  { path: '/admin/items/[id]' },
);
