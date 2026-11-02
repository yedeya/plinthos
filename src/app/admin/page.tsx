/**
 * `/admin`: the signed-in home, the item list ([ITEM-8]). Behind the admin check (`adminPage`,
 * [AUTH-3]): the held list of the device's queue when it isn't empty ([SYNC-8]), the owner's
 * items newest first with the ones still on the device marked as not synced, and **Add set** as
 * the sticky primary action. The footer holds the Publish button (#19), the stored photos' page
 * (#22), the parts page (#161) and the way out, which clears the queue and the service worker's caches after a warning
 * ([SYNC-9]).
 */
import { adminPage } from '../../server/auth/admin';
import { Header, Page } from '../_admin/chrome';
import { listItems } from '../_admin/item-data';
import { ItemList } from '../_admin/item-list';
import { QueuePanel, SignOutButton } from '../_offline/client';
import { en } from '../messages/en';
import { PublishForm } from '../publish-form';
import { publish } from './actions';

export const dynamic = 'force-dynamic';

/** Where the stored photos are listed. */
const PHOTOS_PATH = '/admin/photos';

/** Where the loose parts are imported and summarised (#161). */
const PARTS_PATH = '/admin/parts';

/** Where a new set is entered. */
const NEW_ITEM_PATH = '/admin/items/new';

export default adminPage(
  async ({ admin }) => {
    const items = await listItems(admin);
    return (
      <Page>
        <Header title={en.items.title} />
        <QueuePanel />
        <ItemList items={items} />
        <footer className="footer" aria-label={en.items.footerLabel}>
          <div className="footer__actions">
            <PublishForm action={publish} />
            <a className="button button--link" href={PHOTOS_PATH}>
              {en.items.photos}
            </a>
            <a className="button button--link" href={PARTS_PATH}>
              {en.items.parts}
            </a>
            <SignOutButton />
          </div>
        </footer>
        <div className="action-bar">
          <a className="button button--primary button--wide" href={NEW_ITEM_PATH}>
            {en.items.addSet}
          </a>
        </div>
      </Page>
    );
  },
  { path: '/admin' },
);
