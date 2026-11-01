/**
 * `/admin`: the signed-in home. Behind the admin check (`adminPage`, [AUTH-3]); it shows nothing
 * private yet, only the Publish button (#19) and the way out.
 */
import { adminPage } from '../../server/auth/admin';
import { PublishForm } from '../publish-form';
import { publish } from './actions';

export const dynamic = 'force-dynamic';

export default adminPage(
  async () => (
    <main>
      <h1>Plinthos</h1>
      <p>You are signed in. There is nothing to manage yet but the public catalogue.</p>
      <PublishForm action={publish} />
      <form method="post" action="/admin/logout">
        <button type="submit">Sign out</button>
      </form>
    </main>
  ),
  { path: '/admin' },
);
