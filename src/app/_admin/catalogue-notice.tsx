/**
 * The line `/admin/photos` and `/admin/parts` show after a photo's Delete (#187, [PUB-16]): whether
 * the republish that followed took it off the public catalogue, or the owner must press Publish.
 * The action passes the outcome in the address it redirects to, `?catalogue=updated|stale`;
 * anything else shows nothing.
 */
import { en } from '../messages/en';

export function CatalogueNotice({ outcome }: { readonly outcome: unknown }) {
  const m = en.catalogueAfterDelete;
  if (outcome === 'updated') return <p role="status">{m.updated}</p>;
  if (outcome === 'stale') return <p role="alert">{m.stale}</p>;
  return null;
}

/** The query a delete's redirect carries: the republish's outcome, when there was one to report. */
export function catalogueQuery(outcome: 'updated' | 'stale' | 'not-published' | null): string {
  return outcome === 'updated' || outcome === 'stale' ? `?catalogue=${outcome}` : '';
}
