/**
 * `/admin`: the signed-in home. Behind the admin check (`adminPage`, [AUTH-3]); it shows nothing
 * private yet: the Publish button (#19), the device's offline queue ([SYNC-8]) and the way out,
 * which clears that queue and the service worker's caches after a warning ([SYNC-9]).
 */
import { adminPage } from '../../server/auth/admin';
import { QueuePanel, SignOutButton } from '../_offline/client';
import { PublishForm } from '../publish-form';
import { publish } from './actions';

export const dynamic = 'force-dynamic';

export default adminPage(
  async () => (
    <main>
      <h1>Plinthos</h1>
      <p>You are signed in. There is nothing to manage yet but the public catalogue.</p>
      <PublishForm action={publish} />
      <QueuePanel />
      <SignOutButton />
    </main>
  ),
  { path: '/admin' },
);
