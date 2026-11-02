'use client';

/**
 * The Publish button on `/admin` and what the last publish did. It lives outside `src/app/admin/`
 * because it is a component, not a route; the action it calls is guarded (`./admin/actions.ts`).
 * A failed publish says whether the previous catalogue is still online, with the request id the
 * server's log line carries ([OPS-6]), and whether another publish was running ([PUB-8]).
 * A publish that succeeded ends the header's "press Publish" after a synced delete ([PUB-16]).
 */
import { useActionState } from 'react';
import type { PublishResult } from '../server/publish/publish';
import { clearSyncedCatalogueOutcome } from './_offline/client';
import { en } from './messages/en';

export function PublishForm({ action }: { readonly action: () => Promise<PublishResult> }) {
  const [result, submit, pending] = useActionState<PublishResult | null>(async () => {
    const published = await action();
    if (published.status === 'published') clearSyncedCatalogueOutcome();
    return published;
  }, null);
  return (
    <form action={submit}>
      <button type="submit" className="button button--link" disabled={pending}>
        {pending ? en.publish.pending : en.publish.button}
      </button>
      <PublishOutcome result={result} />
    </form>
  );
}

export function PublishOutcome({ result }: { readonly result: PublishResult | null }) {
  if (result === null) return null;
  const m = en.publish;
  if (result.status === 'published') {
    return (
      <p role="status">
        {m.published(result.publishedAt)} <a href={result.url}>{result.url}</a>
      </p>
    );
  }
  return (
    <p role="alert">
      {m.failed} {result.busy === true ? `${m.busy} ` : ''}
      {result.previousKept ? m.kept : m.partial} {m.reference(result.requestId)}
    </p>
  );
}
