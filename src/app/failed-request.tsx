/**
 * What the admin sees when its server code failed a request ([OPS-5]): the request id that the
 * one `admin.request.failed` log line names, so the owner can search the server function's log
 * group for it. Next.js hands the id to the error page as the error's digest and shows no error
 * message in production, so nothing private reaches the page. The admin wrappers make the digest
 * the request's own UUID (`src/server/auth/admin.ts`); a failure they don't reach keeps the hash
 * Next.js computes (`src/server/request-failure.ts`).
 */
export function FailedRequest({ digest }: { readonly digest: string | undefined }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      {digest === undefined ? (
        <p>This failed in the browser, before the server answered, so the server logged nothing.</p>
      ) : (
        <p>
          The server could not finish this request. Its request id is <code>{digest}</code>: search the admin&apos;s
          log group for it.
        </p>
      )}
    </main>
  );
}
