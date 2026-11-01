/**
 * `/login`: the sign-in form, on the public allow-list ([AUTH-4]). It is a plain form that posts
 * to `/auth/login`, so it works without JavaScript, and it reads nothing but its own query: no
 * cookie, no session, no database ([AUTH-6]). There is no sign-up and no setup page: the one
 * admin account comes from the deployment's configuration ([AUTH-1]).
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { failed } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      {failed === undefined ? null : <p role="alert">That username and password do not match.</p>}
      <form method="post" action="/auth/login">
        <label>
          Username <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
