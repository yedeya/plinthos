/**
 * The set lookup ([CAT-1], [CAT-3], [CAT-5]): how the admin finds a set, over the `lego_set`
 * cache and the set catalogue (`./rebrickable.ts`, a stand-in in tests).
 *
 * - `searchSets` answers the entry form's search, for the signed-in admin only. A query shorter
 *   than two characters calls nothing. A set number fetched in the last 30 days is read from the
 *   table; anything else asks the catalogue, and stores every set it returns. When the catalogue
 *   fails, times out or refuses the key, the answer is `unavailable`, never an error ([CAT-5]):
 *   the form then takes a typed set number, which `saveItem` resolves when it syncs ([ITEM-4]).
 * - `lookupSet` resolves one set number for `saveItem`: from the table when it was fetched in the
 *   last 30 days, else from the catalogue, stored. It answers null for a set the catalogue doesn't
 *   know, and throws `CatalogueUnavailable` when the catalogue can't answer and the table holds no
 *   row to fall back on.
 *
 * Both read and write through `db()`, so a lookup `saveItem` makes joins its transaction. The
 * client logs a failed lookup as `catalogue.lookup.failed` with its reason and never the key.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { legoSet } from '../../db/schema/lego-set';
import { assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger as defaultLogger, type Logger } from '../logger';
import { db } from '../transaction';
import { CatalogueUnavailable, linkedCatalogueProvider, SEARCH_PAGE_SIZE, type CatalogueProvider, type CatalogueSet } from './rebrickable';

/** The shortest query a search asks anything for ([CAT-1]). */
export const SEARCH_MIN_LENGTH = 2;
/** How long a stored set is read from the table without asking the catalogue ([CAT-3]). */
export const FRESH_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** The time a search may spend on the catalogue, retries included ([CAT-2]). */
export const SEARCH_BUDGET_MS = 6_000;
/**
 * The time `saveItem`'s lookup may spend on the catalogue ([ITEM-4]): one request and its theme,
 * at one request a second, inside the offline-sync batch's share of the server function's timeout.
 */
export const LOOKUP_BUDGET_MS = 4_000;

/** A set number as Rebrickable writes one: letters, digits, dots and dashes, such as `10294-1`. */
export const SET_NUM = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/;

/** What the search answers: at most 10 sets, or that the catalogue is unavailable ([CAT-1], [CAT-5]). */
export type SetSearch = { readonly status: 'ok'; readonly sets: CatalogueSet[] } | { readonly status: 'unavailable' };

/**
 * A set number as the table keys it: trimmed, and with Rebrickable's first variant, `-1`, when the
 * owner typed the bare number, as in `10294` for `10294-1`.
 */
export function normalizeSetNum(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? `${trimmed}-1` : trimmed;
}

/** Whether a query could be a set number, which the table may answer without the catalogue. */
function looksLikeSetNum(query: string): boolean {
  return /^\d+(?:-\d+)?$/.test(query);
}

const SearchQuery = z.string().max(200);

export interface CatalogueDependencies {
  /** The catalogue the lookup asks; it is built on first use, so a failure to build one is `unavailable` too. */
  readonly provider: () => CatalogueProvider;
  readonly now?: () => Date;
  readonly log?: Logger;
}

type SetRow = typeof legoSet.$inferSelect;

function toCatalogueSet(row: SetRow): CatalogueSet {
  return { setNum: row.setNum, name: row.name, theme: row.theme, year: row.year, numParts: row.numParts, imageUrl: row.imageUrl };
}

/** Builds the set lookup over a catalogue provider; deployed code uses the ones below. */
export function createCatalogueService(dependencies: CatalogueDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;

  /** The catalogue's own failures are logged by the client; anything else, such as no provider, is logged here. */
  function unavailable(error: unknown, operation: 'search' | 'getSet'): CatalogueUnavailable {
    if (error instanceof CatalogueUnavailable) return error;
    log.warn({ businessEvent: 'catalogue.lookup.failed', operation, reason: 'upstream', cause: error instanceof Error ? error.name : typeof error }, 'a set catalogue lookup failed');
    return new CatalogueUnavailable('upstream');
  }

  async function stored(setNum: string): Promise<SetRow | undefined> {
    const [row] = await db().select().from(legoSet).where(eq(legoSet.setNum, setNum));
    return row;
  }

  function isFresh(row: SetRow): boolean {
    return now().getTime() - row.fetchedAt.getTime() < FRESH_FOR_MS;
  }

  /** Stores sets the catalogue returned, replacing what the table held for them. */
  async function store(sets: readonly CatalogueSet[]): Promise<void> {
    // One row per set number: an upsert can't change one row twice.
    const unique = [...new Map(sets.map((set) => [set.setNum, set])).values()];
    if (unique.length === 0) return;
    const fetchedAt = now();
    await db()
      .insert(legoSet)
      .values(unique.map((set) => ({ setNum: set.setNum, name: set.name, theme: set.theme, year: set.year, numParts: set.numParts, imageUrl: set.imageUrl, fetchedAt })))
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

  /** One set by its number, from the table while it is fresh, else from the catalogue ([CAT-3]). */
  async function lookupSet(setNum: string, options: { readonly budgetMs?: number } = {}): Promise<CatalogueSet | null> {
    const wanted = normalizeSetNum(setNum);
    const row = await stored(wanted);
    if (row !== undefined && isFresh(row)) return toCatalogueSet(row);
    let found: CatalogueSet | null;
    try {
      found = await dependencies.provider().getSet(wanted, { budgetMs: options.budgetMs ?? LOOKUP_BUDGET_MS });
    } catch (error) {
      const failure = unavailable(error, 'getSet');
      // A stale row still names the set: better than no answer while the catalogue is down.
      if (row !== undefined) return toCatalogueSet(row);
      throw failure;
    }
    if (found === null) return row === undefined ? null : toCatalogueSet(row);
    await store([found]);
    return found;
  }

  /** The entry form's search, for the signed-in admin only ([CAT-1], [CAT-3], [CAT-5]). */
  async function searchSets(admin: AdminContext, rawQuery: string): Promise<SetSearch> {
    assertAdmin(admin);
    const query = SearchQuery.parse(rawQuery).trim();
    if (query.length < SEARCH_MIN_LENGTH) return { status: 'ok', sets: [] };
    if (looksLikeSetNum(query)) {
      const row = await stored(normalizeSetNum(query));
      if (row !== undefined && isFresh(row)) return { status: 'ok', sets: [toCatalogueSet(row)] };
    }
    let sets: CatalogueSet[];
    try {
      sets = (await dependencies.provider().searchSets(query, { budgetMs: SEARCH_BUDGET_MS })).slice(0, SEARCH_PAGE_SIZE);
    } catch (error) {
      // Logged as `catalogue.lookup.failed`, with why and never the key ([CAT-4]).
      unavailable(error, 'search');
      return { status: 'unavailable' };
    }
    await store(sets);
    return { status: 'ok', sets };
  }

  return { searchSets, lookupSet };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;

let deployedProvider: CatalogueProvider | undefined;

/** The set lookup as deployed: Rebrickable, with the server function's linked key ([CAT-4]). */
export const catalogue = createCatalogueService({ provider: () => (deployedProvider ??= linkedCatalogueProvider()) });

export const { searchSets, lookupSet } = catalogue;
