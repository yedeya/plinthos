/**
 * The skipped-lots notice's query ([PARTS-1]): pure helpers that the parts page renders on the
 * server and the import's client component calls after an upload. Kept out of
 * `parts-import.tsx`, a client module, because a server component can't call a function from one
 * (#206 shipped that, and `/admin/parts` failed to render).
 */

/** The parts page, which the import reloads into. */
const PARTS_PATH = '/admin/parts';

/** The most skipped lots' places a notice names; the count says how many there were in all. */
export const SKIPPED_PLACES_SHOWN = 10;

/**
 * The query that carries an import's skipped lots across the page's reload ([PARTS-1]), so the
 * notice survives the summary's refresh: the count, and at most `SKIPPED_PLACES_SHOWN` places.
 * Nothing but numbers: never a lot's fields or remarks.
 */
export function skippedQuery(skipped: readonly number[]): string {
  if (skipped.length === 0) return '';
  return `?skipped=${skipped.length}&at=${skipped.slice(0, SKIPPED_PLACES_SHOWN).join(',')}`;
}

/**
 * Where the page goes after an import that succeeded ([PARTS-1]): `/admin/parts`, carrying a
 * skipped-lots notice if and only if *this* import skipped lots. An earlier import's notice is
 * always dropped; any other notice in `currentSearch` (such as `catalogue=stale`, which an import
 * doesn't resolve) is kept.
 */
export function nextPartsUrl(skipped: readonly number[], currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete('skipped');
  params.delete('at');
  if (skipped.length > 0) {
    params.set('skipped', String(skipped.length));
    params.set('at', skipped.slice(0, SKIPPED_PLACES_SHOWN).join(','));
  }
  const query = params.toString();
  return query === '' ? PARTS_PATH : `${PARTS_PATH}?${query.replaceAll('%2C', ',')}`;
}

/** Reads `skippedQuery`'s parameters back, or null when they're absent or not what it writes. */
export function parseSkipped(params: Record<string, string | string[] | undefined> | undefined): { count: number; places: number[] } | null {
  const count = params?.skipped;
  const at = params?.at;
  if (typeof count !== 'string' || typeof at !== 'string' || !/^\d{1,6}$/.test(count) || !/^\d{1,6}(,\d{1,6}){0,9}$/.test(at)) return null;
  const places = at.split(',').map(Number);
  const total = Number(count);
  if (total < places.length || total === 0) return null;
  return { count: total, places };
}

