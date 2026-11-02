/**
 * `/offline`: the data-free app shell ([SYNC-5]), on the public allow-list ([AUTH-4]).
 *
 * It is prerendered at build time and reads no cookie, session or database, so it carries no
 * data and is the same for everyone. The service worker precaches it without credentials and
 * opens an installed admin to it when there is no network. It holds the same entry form as
 * `/admin/items/new`, with a typed set number rather than a search ([ITEM-9], [SYNC-6]), the
 * queue's status, and the items queued on this device: everything it shows comes from the
 * device's own queue, in the browser.
 */
import { Header, Page } from '../_admin/chrome';
import { EntryForm } from '../_admin/entry-form';
import { QueuedItemList } from '../_admin/item-list';
import { QueuePanel } from '../_offline/client';
import { en } from '../messages/en';

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <Page>
      <Header title={en.offline.title} />
      <p className="muted">{en.offline.intro}</p>
      <QueuePanel />
      <EntryForm mode="offline" />
      <QueuedItemList title={en.offline.queuedTitle} />
      <p>
        <a className="button button--link" href="/admin">
          {en.offline.openAdmin}
        </a>
      </p>
    </Page>
  );
}
