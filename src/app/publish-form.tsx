'use client';

/**
 * The Publish button on `/admin` and what the last publish did. It lives outside `src/app/admin/`
 * because it is a component, not a route; the action it calls is guarded (`./admin/actions.ts`).
 * A failed publish says whether the previous catalogue is still online, with the request id the
 * server's log line carries ([OPS-6]).
 */
import { useActionState } from 'react';
import type { PublishResult } from '../server/publish/publish';

export function PublishForm({ action }: { readonly action: () => Promise<PublishResult> }) {
  const [result, submit, pending] = useActionState<PublishResult | null>(() => action(), null);
  return (
    <form action={submit}>
      <button type="submit" disabled={pending}>
        {pending ? 'Publishing…' : 'Publish'}
      </button>
      <PublishOutcome result={result} />
    </form>
  );
}

export function PublishOutcome({ result }: { readonly result: PublishResult | null }) {
  if (result === null) return null;
  if (result.status === 'published') {
    return (
      <p role="status">
        Published at {result.publishedAt}: <a href={result.url}>{result.url}</a>
      </p>
    );
  }
  return (
    <p role="alert">
      Publishing failed.{' '}
      {result.previousKept ? 'The previous catalogue is still online, unchanged.' : 'The catalogue may be partly updated: publish again.'}{' '}
      Reference: {result.requestId}
    </p>
  );
}
