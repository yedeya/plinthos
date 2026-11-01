/**
 * `/admin`: the signed-in placeholder. Behind the admin check (`adminPage`, [AUTH-3]); it shows
 * nothing private yet, only the way out.
 */
import { adminPage } from '../../server/auth/admin';

export const dynamic = 'force-dynamic';

export default adminPage(
  async () => (
    <main>
      <h1>Plinthos</h1>
      <p>You are signed in. There is nothing to manage yet.</p>
      <form method="post" action="/admin/logout">
        <button type="submit">Sign out</button>
      </form>
    </main>
  ),
  { path: '/admin' },
);
