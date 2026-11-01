/**
 * `/offline`: the data-free app shell ([SYNC-5]), on the public allow-list ([AUTH-4]).
 *
 * It is prerendered at build time and reads no cookie, session or database, so it carries no
 * data and is the same for everyone. The service worker precaches it without credentials and
 * opens an installed admin to it when there is no network. What it shows comes from the
 * device's own queue, in the browser.
 */
import { QueuePanel } from '../_offline/client';

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main>
      <h1>Plinthos</h1>
      <p>This is the admin&apos;s offline shell. Changes made here wait on this device until there is a network.</p>
      <QueuePanel />
      <p>
        <a href="/admin">Open the admin</a>
      </p>
    </main>
  );
}
