/**
 * The set lookup (#124, [CAT-1], [CAT-3], [CAT-5]): the admin finds a set by number or name, and
 * `saveItem` resolves the set an item names. Both read and write the `lego_set` table, which
 * caches what the set catalogue (Rebrickable, `./rebrickable.ts`) answered:
 *
 * - `lookupSet` reads the table for a set fetched in the last 30 days and asks the catalogue
 *   nothing; an older or missing row is fetched again and stored. When the catalogue can't answer
 *   and the table holds an older row, that row answers rather than nothing.
 * - `searchSets` always asks the catalogue, and stores every set it returns. A query shorter
 *   than two characters answers nothing and asks nothing.
 *
 * A catalogue that times out, rate-limits or refuses the key makes a search answer `unavailable`
 * rather than throw, so the entry form says search is unavailable and still takes a typed set
 * number ([CAT-5]); `lookupSet` throws it, so a `saveItem` that needed it is `failed` and retried
 * ([ITEM-4]). The provider itself logs `catalogue.lookup.failed` with the reason, never the key
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
import { eq, sql } from 'drizzle-orm';
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

/** Whether a query reads as a set number, such as `10294` or `10294-1`, rather than a name. */
export function looksLikeSetNum(query: string): boolean {
  return /^[A-Za-z0-9]+(-\d+)?$/.test(query) && /\d/.test(query);
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

/** How long a search spends looking up a typed set number directly, out of `SEARCH_BUDGET_MS`. */
export const EXACT_LOOKUP_BUDGET_MS = 2_500;

export type SearchResult = { readonly status: 'ok'; readonly sets: CatalogueSet[] } | { readonly status: 'unavailable' };

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
  async function lookupSet(setNum: string, options: { readonly budgetMs: number }): Promise<CatalogueSet | null> {
    const key = normalizeSetNum(SetNum.parse(setNum));
    const [row] = await db().select().from(legoSet).where(eq(legoSet.setNum, key));
    if (row !== undefined && now().getTime() - row.fetchedAt.getTime() < FRESH_FOR_MS) return fromRow(row);
    let found: CatalogueSet | null;
    try {
      found = await dependencies.provider().getSet(key, { budgetMs: options.budgetMs });
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
   * The admin's search by set number or name ([CAT-1]): at most 10 sets, every one stored
   * ([CAT-3]). A query shorter than two characters answers nothing and asks nothing. A catalogue
   * that can't answer makes it `unavailable` ([CAT-5]).
   */
  async function searchSets(admin: AdminContext, query: string): Promise<SearchResult> {
    assertAdmin(admin);
    const trimmed = typeof query === 'string' ? query.trim().slice(0, 100) : '';
    if (trimmed.length < MIN_QUERY) return { status: 'ok', sets: [] };
    // A typed set number is looked up directly too: the catalogue's search ranks loosely and
    // answers only ten, so the exact set can come back low or not at all.
    let exact: CatalogueSet | null = null;
    if (looksLikeSetNum(trimmed)) {
      try {
        exact = await lookupSet(trimmed, { budgetMs: EXACT_LOOKUP_BUDGET_MS });
      } catch (error) {
        if (!(error instanceof CatalogueUnavailable)) throw error;
      }
    }
    let found: CatalogueSet[];
    try {
      found = await dependencies.provider().searchSets(trimmed, { budgetMs: SEARCH_BUDGET_MS - (exact === null ? 0 : EXACT_LOOKUP_BUDGET_MS) });
    } catch (error) {
      if (!(error instanceof CatalogueUnavailable)) throw error;
      // The exact set alone is still an answer while the search is down.
      if (exact !== null) return { status: 'ok', sets: [exact] };
      return { status: 'unavailable' };
    }
    const merged = exact === null ? found : [exact, ...found.filter((set) => set.setNum !== exact.setNum)];
    const sets = rankSets(trimmed, merged).slice(0, MAX_RESULTS);
    await store(sets);
    return { status: 'ok', sets };
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
