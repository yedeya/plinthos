/**
 * How a set search ranks its results ([CAT-1]), shared by the server's search (`./sets.ts`) and
 * the phone's search of the set index (`src/app/_offline/set-index.ts`, [CAT-11]), so both rank
 * alike. Pure: it imports nothing, so the device's bundle and the data-free shell take it.
 */

/** The catalogue's form of a set number: one typed without its variant, `10179`, is its first, `10179-1`. */
export function normalizeSetNum(setNum: string): string {
  const trimmed = setNum.trim();
  return /-\d+$/.test(trimmed) ? trimmed : `${trimmed}-1`;
}

/** The shortest query looked up directly as a set number: shorter ones are prefixes typed on the way. */
export const EXACT_MIN_LENGTH = 4;

/**
 * Whether a query reads as a set number, such as `10294` or `10294-1`, rather than a name: at
 * least `EXACT_MIN_LENGTH` and at most 40 characters (`SetNum`'s cap), with a digit.
 */
export function looksLikeSetNum(query: string): boolean {
  return query.length >= EXACT_MIN_LENGTH && query.length <= 40 && /^[A-Za-z0-9]+(-\d+)?$/.test(query) && /\d/.test(query);
}

/** What ranking reads of a result. */
export interface Rankable {
  readonly setNum: string;
  readonly name: string;
}

/** The rank `rankSets` gives a result whose number is exactly the query, its other variants, a number that starts with it, a name that holds it, and the rest. */
export const RANK = { exact: 0, variant: 1, prefix: 2, name: 3, rest: 4 } as const;

/**
 * The rank of one result for a query, by `rankSets`'s rules: the set whose number is exactly the
 * query (`10294` is `10294-1`), its other variants (`10294-2`), a number that starts with the
 * query, a name that holds it, then the rest. Made once per query, then applied to each result.
 */
export function rankerFor(query: string): (set: Rankable) => number {
  const q = query.trim().toLowerCase();
  const exact = looksLikeSetNum(q) ? normalizeSetNum(q) : null;
  const base = q.replace(/-\d+$/, '');
  return (set) => {
    const num = set.setNum.toLowerCase();
    if (exact !== null && num === exact) return RANK.exact;
    if (num.replace(/-\d+$/, '') === base) return RANK.variant;
    if (num.startsWith(q)) return RANK.prefix;
    if (set.name.toLowerCase().includes(q)) return RANK.name;
    return RANK.rest;
  };
}

/**
 * Orders search results for the admin ([CAT-1]): the set whose number is exactly the query
 * first (`10294` is `10294-1`), then its other variants (`10294-2`), then sets whose number
 * starts with the query, then sets whose name holds it, then the rest, each group in the
 * catalogue's own order.
 */
export function rankSets<T extends Rankable>(query: string, sets: readonly T[]): T[] {
  const rank = rankerFor(query);
  return sets
    .map((set, index) => ({ set, index, rank: rank(set) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ set }) => set);
}
