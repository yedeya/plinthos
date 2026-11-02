/**
 * `/admin/items/new`: the one-screen entry form for a new set ([ITEM-9]), behind the admin check
 * (`adminPage`, [AUTH-3]). It reads nothing from the database: the form searches the catalogue
 * through the admin's search route as the owner types, and queues what it saves on the device
 * ([ITEM-7]), which the queue's sync replays.
 */
import { adminPage } from '../../../../server/auth/admin';
import { photoSettings } from '../../../../server/photos/config';
import { Header, Page } from '../../../_admin/chrome';
import { EntryForm } from '../../../_admin/entry-form';
import { QueueSync } from '../../../_offline/client';
import { en } from '../../../messages/en';

export const dynamic = 'force-dynamic';

export default adminPage(
  async () => (
    <Page>
      <Header title={en.form.addTitle} back={{ href: '/admin', label: en.form.back }} />
      <EntryForm mode="new" longestEdge={photoSettings().longestEdge} />
      <QueueSync />
    </Page>
  ),
  { path: '/admin/items/new' },
);
