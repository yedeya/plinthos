/**
 * `/admin/items/[id]`: an item in the entry form, to edit online or delete ([ITEM-9]), behind the
 * admin check (`adminPage`, [AUTH-3]). It opens with the item the server holds and its version, so
 * a stale edit meets the conflict rule when it syncs ([ITEM-3]). An id that is not a UUID, or that
 * no item has, is a not-found.
 */
import { notFound } from 'next/navigation';
import { adminPage } from '../../../../server/auth/admin';
import { photoSettings } from '../../../../server/photos/config';
import { Header, Page } from '../../../_admin/chrome';
import { EntryForm } from '../../../_admin/entry-form';
import { getItem } from '../../../_admin/item-data';
import { QueueSync } from '../../../_offline/client';
import { en } from '../../../messages/en';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default adminPage<{ readonly params: Promise<{ readonly id?: string }> }>(
  async ({ admin, params }) => {
    const { id } = await params;
    if (id === undefined || !UUID.test(id)) notFound();
    const item = await getItem(admin, id);
    if (item === null) notFound();
    return (
      <Page>
        <Header title={en.form.editTitle} back={{ href: '/admin', label: en.form.back }} />
        <EntryForm mode="edit" item={item} longestEdge={photoSettings().longestEdge} />
        <QueueSync />
      </Page>
    );
  },
  { path: '/admin/items/[id]' },
);
