/**
 * `/admin`: the signed-in home, the item list ([ITEM-8]). Behind the admin check (`adminPage`,
 * [AUTH-3]): the held list of the device's queue when it isn't empty ([SYNC-8]), the owner's
 * items newest first with the ones still on the device marked as not synced, filtered and sorted
 * as the query string says (#251, [ITEM-18]), and **Add set** as
 * the sticky primary action. The footer holds the Publish button (#19), the stored photos' page
 * (#22), the parts page (#161), the catalogue's settings (#163), the printable summary and the two
 * CSV downloads (#236, [EXP-1]) and the way out, which clears the
 * queue and the service worker's caches after a warning ([SYNC-9]). Each item shows its value with
 * its source and date, and under the list are the totals per segment and **Refresh prices**
 * (#207, [VAL-3], [VAL-7]) with the running refresh's progress, **Stop** and the last run's
 * outcome (#229, [VAL-11]), all private to the admin. Under them, when the set index on this
 * device was built, which opening the page online checks once ([CAT-10]).
 */
import { adminPage } from '../../server/auth/admin';
import { Header, Page } from '../_admin/chrome';
import { listItems } from '../_admin/item-data';
import { SetIndexStatus } from '../_admin/set-index-status';
import { ItemList } from '../_admin/item-list';
import { withValues } from '../_admin/value-data';
import { RefreshPrices, ValueTotals } from '../_admin/values';
import { priceRefreshStatus } from '../../server/valuation/job';
import { readAdminValues } from '../../server/valuation/refresh';
import { QueuePanel, SignOutButton } from '../_offline/client';
import { en } from '../messages/en';
import { PublishForm } from '../publish-form';
import { publish, refreshStatus, startRefresh, stopRefresh } from './actions';

export const dynamic = 'force-dynamic';

/** Where the stored photos are listed. */
const PHOTOS_PATH = '/admin/photos';

/** Where the loose parts are imported and summarised (#161). */
const PARTS_PATH = '/admin/parts';

/** Where the catalogue's texts and link are set. */
const SETTINGS_PATH = '/admin/settings';

/** The export's two downloads and the printable summary (#236, [EXP-1], [EXP-5]). */
const EXPORT_BUYER_PATH = '/admin/export/buyer';
const EXPORT_FULL_PATH = '/admin/export/full';
const SUMMARY_PATH = '/admin/summary';

/** Where a new set is entered. */
const NEW_ITEM_PATH = '/admin/items/new';

/** The page's query string as Next.js hands it, back into one string: the list's state ([ITEM-18]). */
function queryString(params: Record<string, string | string[] | undefined> | undefined): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params ?? {})) for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(name, one);
  return search.toString();
}

export default adminPage<{ readonly searchParams?: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ admin, searchParams }) => {
    const [items, valued, refresh] = await Promise.all([listItems(admin), readAdminValues(admin), priceRefreshStatus(admin)]);
    return (
      <Page wide>
        <Header title={en.items.title} />
        <QueuePanel />
        <ItemList items={withValues(items, valued.values.items)} query={queryString(await searchParams)} />
        <ValueTotals totals={valued.totals} />
        <RefreshPrices start={startRefresh} stop={stopRefresh} status={refreshStatus} initial={refresh} />
        <SetIndexStatus />
        <footer className="footer" aria-label={en.items.footerLabel}>
          <div className="footer__actions">
            <PublishForm action={publish} />
            <a className="button button--link" href={PHOTOS_PATH}>
              {en.items.photos}
            </a>
            <a className="button button--link" href={PARTS_PATH}>
              {en.items.parts}
            </a>
            <a className="button button--link" href={SETTINGS_PATH}>
              {en.items.settings}
            </a>
            <a className="button button--link" href={SUMMARY_PATH}>
              {en.items.summaryLink}
            </a>
            <a className="button button--link" href={EXPORT_BUYER_PATH} download>
              {en.items.exportBuyer}
            </a>
            <a className="button button--link" href={EXPORT_FULL_PATH} download>
              {en.items.exportFull}
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
