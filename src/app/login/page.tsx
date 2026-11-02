/**
 * `/login`: the sign-in form, on the public allow-list ([AUTH-4]). It is a plain form that posts
 * to `/auth/login`, so it works without JavaScript, and it reads nothing but its own query: no
 * cookie, no session, no database ([AUTH-6]). There is no sign-up and no setup page: the one
 * admin account comes from the deployment's configuration ([AUTH-1]). A centred card with the
 * wordmark (`docs/design/ui.md`).
 */
import { en } from '../messages/en';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { failed } = await searchParams;
  const m = en.login;
  return (
    <main className="login">
      <form className="login__card card" method="post" action="/auth/login">
        <p className="wordmark">{en.app.wordmark}</p>
        <h1>{m.title}</h1>
        <label className="field">
          <span className="field__label">{m.username}</span>
          <input className="input" name="username" autoComplete="username" autoCapitalize="none" required aria-invalid={failed !== undefined} />
        </label>
        <label className="field">
          <span className="field__label">{m.password}</span>
          <input className="input" name="password" type="password" autoComplete="current-password" required aria-invalid={failed !== undefined} />
          {failed === undefined ? null : (
            <span className="field__error" role="alert">
              {m.failed}
            </span>
          )}
        </label>
        <button type="submit" className="button button--primary button--wide">
          {m.submit}
        </button>
      </form>
    </main>
  );
}
