/**
 * What the admin sees when its server code failed a request ([OPS-5]): the request id that the
 * one `admin.request.failed` log line names, so the owner can search the server function's log
 * group for it. Next.js hands the id to the error page as the error's digest and shows no error
 * message in production, so nothing private reaches the page. The admin wrappers make the digest
 * the request's own UUID (`src/server/auth/admin.ts`); a failure they don't reach keeps the hash
 * Next.js computes (`src/server/request-failure.ts`).
 */
import { en } from './messages/en';

export function FailedRequest({ digest }: { readonly digest: string | undefined }) {
  const m = en.failure;
  return (
    <main className="page">
      <h1>{m.title}</h1>
      {digest === undefined ? (
        <p>{m.browser}</p>
      ) : (
        <p>
          {m.serverBefore} <code>{digest}</code>
          {m.serverAfter}
        </p>
      )}
    </main>
  );
}
