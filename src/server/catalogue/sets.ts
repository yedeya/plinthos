/**
 * The set lookup (#124, [CAT-1], [CAT-3], [CAT-5]): the admin finds a set by number or name, and
 * `saveItem` resolves the set an item names. Both read and write the `lego_set` table, which
 * caches what the set catalogue (Rebrickable, `./rebrickable.ts`) answered:
 *
 * - `lookupSet` reads the table for a set fetched in the last 30 days and asks the catalogue
 *   nothing; an older or missing row is fetched again and stored. When the catalogue can't answer
 *   and the table holds an older row, that row answers rather than nothing.
 * - `searchSets` reads the table first (a set number that starts with the query, or a name that
 *   holds it), then asks the catalogue, and stores every set the catalogue returns. A typed set
 *   number whose set the table already holds is not looked up again. A query shorter than two
 *   characters answers nothing and asks nothing.
 *
 * A catalogue that times out, rate-limits or refuses the key makes a search answer what the table
 * holds, marked `partial`, or `unavailable` when the table holds nothing for it, rather than
 * throw, so the entry form says so quietly and still saves a typed set number ([CAT-5]).
 * `lookupSet` throws it, so a `saveItem` that needed it is `failed` and retried ([ITEM-4]). The provider itself logs `catalogue.lookup.failed` with the reason, never the key
 * (`./rebrickable.ts`), so nothing here logs it twice.
 *
 * The catalogue is reached through one function, `CatalogueDependencies.provider`, so tests give
 * a stand-in and only the deployed service reads the `RebrickableApiKey` secret
 * (`linkedCatalogueProvider`).
 *
 * Set numbers are normalized before the table or the catalogue sees them (the Lead's decision on
 * #127): trimmed, never re-cased, and given `-1` when they carry no `-<digits>` variant, so a
 * typed `10294` is `10294-1`. The normalized form is what is stored and shown.
 */
import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { legoSet } from '../../db/schema/lego-set';
import { assertAdmin, type AdminContext } from '../auth/admin-context';
import { db } from '../transaction';
import { CatalogueUnavailable, linkedCatalogueProvider, type CatalogueProvider, type CatalogueSet } from './rebrickable';

export type { CatalogueSet } from './rebrickable';

/** How long a looked-up set answers from the table without asking the catalogue ([CAT-3]). */
export const FRESH_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** The shortest query a search sends ([CAT-1]). */
export const MIN_QUERY = 2;
/** The most sets a search answers ([CAT-1]). */
export const MAX_RESULTS = 10;
/** What a search may take, retries included: the admin is waiting on the form. */
export const SEARCH_BUDGET_MS = 6_000;

/** A set number as the catalogue writes one, such as `10179-1`, or as typed, such as `10179`. */
export const SetNum = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a set number is letters, digits, dots, dashes and underscores, such as 10179-1');

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

/**
 * Orders search results for the admin ([CAT-1]): the set whose number is exactly the query
 * first (`10294` is `10294-1`), then its other variants (`10294-2`), then sets whose number
 * starts with the query, then sets whose name holds it, then the rest, each group in the
 * catalogue's own order.
 */
export function rankSets(query: string, sets: readonly CatalogueSet[]): CatalogueSet[] {
  const q = query.trim().toLowerCase();
  const exact = looksLikeSetNum(q) ? normalizeSetNum(q) : null;
  const base = q.replace(/-\d+$/, '');
  const rank = (set: CatalogueSet): number => {
    const num = set.setNum.toLowerCase();
    if (exact !== null && num === exact) return 0;
    if (num.replace(/-\d+$/, '') === base) return 1;
    if (num.startsWith(q)) return 2;
    if (set.name.toLowerCase().includes(q)) return 3;
    return 4;
  };
  return sets
    .map((set, index) => ({ set, index, rank: rank(set) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ set }) => set);
}

/** The most a search spends looking up a typed set number directly, out of `SEARCH_BUDGET_MS`. */
export const EXACT_LOOKUP_BUDGET_MS = 2_500;

/** Below this, a search that has used its budget on the direct lookup doesn't start the catalogue's search. */
export const MIN_SEARCH_BUDGET_MS = 500;

/**
 * A search's answer. `partial` marks one the catalogue could not complete: the sets are what the
 * table held, and the direct lookup found, without the catalogue's own search ([CAT-5]).
 */
export type SearchResult = { readonly status: 'ok'; readonly sets: CatalogueSet[]; readonly partial?: true } | { readonly status: 'unavailable' };

/** How many rows of the table a search ranks before it keeps `MAX_RESULTS`. */
const LOCAL_CANDIDATES = 50;

/** A query as a `LIKE` pattern's literal part: `%`, `_` and `\` match only themselves. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface CatalogueDependencies {
  /** The set catalogue. Deployed: Rebrickable with the `RebrickableApiKey` secret. */
  readonly provider: () => CatalogueProvider;
  readonly now?: () => Date;
}

type LegoSetRow = typeof legoSet.$inferSelect;

function fromRow(row: LegoSetRow): CatalogueSet {
  return { setNum: row.setNum, name: row.name, theme: row.theme, year: row.year, numParts: row.numParts, imageUrl: row.imageUrl };
}

export function createCatalogueService(dependencies: CatalogueDependencies) {
  const now = dependencies.now ?? (() => new Date());

  /** Stores what the catalogue answered, replacing an older row of the same set. */
  async function store(sets: readonly CatalogueSet[]): Promise<void> {
    if (sets.length === 0) return;
    const fetchedAt = now();
    await db()
      .insert(legoSet)
      .values(sets.map((set) => ({ ...set, fetchedAt })))
      .onConflictDoUpdate({
        target: legoSet.setNum,
        set: {
          name: sql`excluded.name`,
          theme: sql`excluded.theme`,
          year: sql`excluded.year`,
          numParts: sql`excluded.num_parts`,
          imageUrl: sql`excluded.image_url`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }

  /** The set the table holds under this number, however old, or null. */
  async function storedSet(setNum: string): Promise<CatalogueSet | null> {
    const [row] = await db().select().from(legoSet).where(eq(legoSet.setNum, normalizeSetNum(setNum)));
    return row === undefined ? null : fromRow(row);
  }

  /**
   * One set by its number ([CAT-3]): from the table when it was fetched in the last 30 days,
   * otherwise from the catalogue, stored. Null when the catalogue doesn't know it. Throws
   * `CatalogueUnavailable` when the catalogue can't answer and the table holds no row of it.
   */
  async function lookupSet(setNum: string, options: { readonly budgetMs: number; readonly signal?: AbortSignal }): Promise<CatalogueSet | null> {
    const key = normalizeSetNum(SetNum.parse(setNum));
    const [row] = await db().select().from(legoSet).where(eq(legoSet.setNum, key));
    if (row !== undefined && now().getTime() - row.fetchedAt.getTime() < FRESH_FOR_MS) return fromRow(row);
    let found: CatalogueSet | null;
    try {
      found = await dependencies.provider().getSet(key, { budgetMs: options.budgetMs, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      if (!(error instanceof CatalogueUnavailable)) throw error;
      // An older row is better than none while the catalogue is down.
      if (row !== undefined) return fromRow(row);
      throw error;
    }
    if (found === null) return null;
    await store([found]);
    return found;
  }

  /**
   * The sets the table holds for a query, at most `MAX_RESULTS`, ranked by `rankSets`: a set
   * number that starts with it (`10294` finds `10294-1` and `10294-2`) or a name that holds it,
   * and the exact typed set first; and whether that exact set was fetched in the last 30 days
   * ([CAT-3]). It asks the catalogue nothing.
   */
  async function localSets(query: string): Promise<{ readonly sets: CatalogueSet[]; readonly exactFresh: boolean }> {
    const literal = likeLiteral(query);
    const exact = looksLikeSetNum(query) ? normalizeSetNum(query) : null;
    const rows = await db()
      .select()
      .from(legoSet)
      .where(or(ilike(legoSet.setNum, `${literal}%`), ilike(legoSet.name, `%${literal}%`)))
      .orderBy(desc(sql`lower(${legoSet.setNum}) = ${exact?.toLowerCase() ?? ''}`), legoSet.setNum)
      .limit(LOCAL_CANDIDATES);
    const exactRow = exact === null ? undefined : rows.find((row) => row.setNum.toLowerCase() === exact.toLowerCase());
    return {
      sets: rankSets(query, rows.map(fromRow)).slice(0, MAX_RESULTS),
      exactFresh: exactRow !== undefined && now().getTime() - exactRow.fetchedAt.getTime() < FRESH_FOR_MS,
    };
  }

  /**
   * The admin's search by set number or name ([CAT-1]): at most 10 sets, ranked by `rankSets`.
   * A query shorter than two characters answers nothing and asks nothing. It reads the table
   * first (`localSets`). A query that reads as a set number whose set the table holds, fetched in
   * the last 30 days, answers from the table alone and asks the catalogue nothing, as `lookupSet`
   * would. One whose set the table doesn't hold is looked up directly (`lookupSet`), so its exact set is there even when the catalogue's search
   * ranks it low; then the catalogue's search is asked, and every set it returns is stored
   * ([CAT-3]). The lookup and the search share one deadline, `SEARCH_BUDGET_MS` from the call's
   * start. Local and catalogue sets are merged by set number, the catalogue's fresher copy kept.
   * A catalogue that can't answer makes the search answer what it has, marked `partial`, or
   * `unavailable` when it has nothing ([CAT-5]). `signal`, the request's own, stops it asking the
   * catalogue once the browser has given up on the search.
   */
  async function searchSets(admin: AdminContext, query: string, options: { readonly signal?: AbortSignal } = {}): Promise<SearchResult> {
    assertAdmin(admin);
    const trimmed = typeof query === 'string' ? query.trim().slice(0, 100) : '';
    if (trimmed.length < MIN_QUERY) return { status: 'ok', sets: [] };
    const deadline = now().getTime() + SEARCH_BUDGET_MS;
    const { sets: local, exactFresh } = await localSets(trimmed);
    // A typed set number the table holds, fresh: the commonest search while entering sets, and
    // it needs no request queued behind the per-instance limiter ([CAT-2]).
    if (exactFresh) return { status: 'ok', sets: local };

    // A typed set number is looked up directly too, unless the table already holds it: the
    // catalogue's search ranks loosely and answers only ten, so the exact set can come back low.
    let exact: CatalogueSet | null = null;
    if (looksLikeSetNum(trimmed)) {
      const wanted = normalizeSetNum(trimmed).toLowerCase();
      if (!local.some((set) => set.setNum.toLowerCase() === wanted)) {
        try {
          exact = await lookupSet(trimmed, { budgetMs: EXACT_LOOKUP_BUDGET_MS, ...options });
        } catch (error) {
          if (!(error instanceof CatalogueUnavailable)) throw error;
        }
      }
    }
    const known = exact === null ? local : [exact, ...local];
    const partial = (): SearchResult => (known.length === 0 ? { status: 'unavailable' } : { status: 'ok', sets: rankSets(trimmed, known).slice(0, MAX_RESULTS), partial: true });

    // What the table and the lookup spent comes out of the search's share.
    const left = deadline - now().getTime();
    if (left < MIN_SEARCH_BUDGET_MS || options.signal?.aborted === true) return partial();
    let found: CatalogueSet[];
    try {
      found = await dependencies.provider().searchSets(trimmed, { budgetMs: left, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      if (!(error instanceof CatalogueUnavailable)) throw error;
      return partial();
    }
    await store(found);
    // One copy per set number, in the order first met, with the catalogue's fresher fields.
    const merged = new Map<string, CatalogueSet>();
    for (const set of known) merged.set(set.setNum, set);
    for (const set of found) merged.set(set.setNum, set);
    return { status: 'ok', sets: rankSets(trimmed, [...merged.values()]).slice(0, MAX_RESULTS) };
  }

  return { lookupSet, searchSets, storedSet };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;

let deployedProvider: CatalogueProvider | undefined;

/** The deployed set catalogue: Rebrickable over the linked `RebrickableApiKey`, read only on the server ([CAT-4]). */
export function deployedCatalogueProvider(): CatalogueProvider {
  return (deployedProvider ??= linkedCatalogueProvider());
}

export const catalogue = createCatalogueService({ provider: deployedCatalogueProvider });

export const { lookupSet, searchSets } = catalogue;
