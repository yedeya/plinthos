/**
 * Next.js's instrumentation hook. `onRequestError` sees every server failure that escapes a page,
 * a server action or a Route Handler, and logs it as `admin.request.failed` under the digest the
 * error page shows, unless an admin wrapper has logged it already ([OPS-5],
 * `src/server/request-failure.ts`).
 *
 * The logger is imported only in the Node.js runtime, so an edge bundle never pulls in pino.
 */
import type { Instrumentation } from 'next';

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === 'edge') return;
  const { reportRequestError } = await import('./server/request-failure');
  reportRequestError(error, request, context);
};
