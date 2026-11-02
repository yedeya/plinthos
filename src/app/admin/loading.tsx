/**
 * The admin's loading screen (#203): what Next.js streams at once, before a page under `/admin`
 * has its data, so that opening the admin while Aurora resumes from a pause (`[PLAT-10]`, up to
 * `RESUME_BUDGET_MS`) shows a spinner rather than a blank screen. It needs the server function's
 * streaming wrapper to reach the browser first (`open-next.config.ts`).
 *
 * It is the one segment file under `/admin` that is not built with `adminPage` ([AUTH-4]): it holds
 * no data, reads no request, no cookie and no database, and imports nothing but the message file,
 * so it is the same for anyone, signed in or not. `tests/app/admin-routes.test.ts` holds it to that.
 * The page it stands in for still runs its own admin check. The service worker never stores it:
 * it is part of an `/admin` navigation's response, which the worker never caches ([SYNC-6]).
 */
import { en } from '../messages/en';

export default function Loading() {
  return (
    <main className="page">
      <div className="loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <p className="loading__title">{en.loading.title}</p>
        <p className="muted">{en.loading.hint}</p>
      </div>
    </main>
  );
}
