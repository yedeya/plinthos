/**
 * The theme backfill ([ITEM-13], brief #251): fills the theme id and the top-level theme of the
 * sets stored before `lego_set` kept them ([ITEM-11]). Every set a lookup or a search stores since
 * carries both (`./sets.ts`, [ITEM-12]), so this is for the older rows, and only those an item
 * names: a search stores many sets nobody owns, and those fill on their next fetch.
 *
 * A stored row holds its leaf theme's name, never its id, and a name may occur under more than
 * one parent in Rebrickable's tree, so a name alone is never guessed from:
 *
 * - It reads Rebrickable's theme list once (`listThemes`).
 * - A set whose theme name occurs once in the tree takes that theme, and the root above it, with
 *   no further request.
 * - A set whose name occurs more than once, or nowhere, is looked up by its set number, one
 *   request each, through the one client ([CAT-2]).
 * - A set Rebrickable can't answer for keeps a null top-level theme, so the next run tries it
 *   again; one whose key Rebrickable refuses ends the lookups, since every next one would be
 *   refused too, and so does the end of the run's budget.
 * - A run with nothing to fill asks Rebrickable nothing.
 *
 * It runs in the deploy's migration step, after the migrations (`scripts/migrate.ts`,
 * `docs/deploy.md` step 5), through `backfillThemesAfterMigrations`, whose failure never fails
 * that step. It logs `catalogue.themes.backfilled` with its counts (`docs/observability.md`).
 */
import { and, asc, eq, exists, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { collectionItem } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { logger } from '../logger';
import { db } from '../transaction';
import { CatalogueUnavailable, topThemeOf, type CatalogueTheme } from './rebrickable';
import { deployedCatalogueProvider, type CatalogueDependencies } from './sets';

/** What a run may spend on Rebrickable by default: a few hundred lookups at one a second. */
export const BACKFILL_BUDGET_MS = 10 * 60 * 1000;
/** What the theme list may take, retries included, out of the run's budget. */
export const THEME_LIST_BUDGET_MS = 30_000;
/** What one lookup may take, retries included, out of the run's budget. */
export const LOOKUP_BUDGET_MS = 15_000;
/** Below this, what is left of the run's budget starts no lookup. */
export const MIN_LOOKUP_BUDGET_MS = 2_000;

export const BackfillThemesInput = z
  .object({
    /** What the whole run may spend on Rebrickable; a set it doesn't reach waits for the next run. */
    budgetMs: z.number().int().positive().max(60 * 60 * 1000).default(BACKFILL_BUDGET_MS),
  })
  .strict();

/** How many sets a run filled from their theme's name alone, filled by a lookup, and left unknown. */
export interface BackfillResult {
  readonly filledByName: number;
  readonly filledByLookup: number;
  readonly unknown: number;
}

export function createThemeBackfill(dependencies: CatalogueDependencies) {
  const nowMs = () => (dependencies.now?.() ?? new Date()).getTime();

  async function fill(setNum: string, themeId: number | null, topTheme: string | null): Promise<void> {
    await db().update(legoSet).set({ themeId, topTheme }).where(eq(legoSet.setNum, setNum));
  }

  /** Fills the theme id and the top-level theme of every set an item names whose top-level theme is null ([ITEM-13]). */
  return async function backfillThemes(input: z.input<typeof BackfillThemesInput>): Promise<BackfillResult> {
    const { budgetMs } = BackfillThemesInput.parse(input);
    const deadline = nowMs() + budgetMs;
    const unfilled = await db()
      .select({ setNum: legoSet.setNum, theme: legoSet.theme })
      .from(legoSet)
      .where(and(isNull(legoSet.topTheme), exists(db().select({ setNum: collectionItem.setNum }).from(collectionItem).where(eq(collectionItem.setNum, legoSet.setNum)))))
      .orderBy(asc(legoSet.setNum));

    const counts = { filledByName: 0, filledByLookup: 0, unknown: 0 };
    if (unfilled.length > 0) {
      const provider = dependencies.provider();
      const themes: CatalogueTheme[] = await provider.listThemes({ budgetMs: Math.min(THEME_LIST_BUDGET_MS, budgetMs) });
      const byId = new Map(themes.map((theme) => [theme.id, theme]));
      const idsByName = new Map<string, number[]>();
      for (const theme of themes) idsByName.set(theme.name, [...(idsByName.get(theme.name) ?? []), theme.id]);

      let lookups = true;
      for (const set of unfilled) {
        const ids = idsByName.get(set.theme) ?? [];
        const [only] = ids;
        if (ids.length === 1 && only !== undefined) {
          const top = topThemeOf(only, byId);
          if (top !== undefined) {
            await fill(set.setNum, only, top);
            counts.filledByName += 1;
          } else {
            counts.unknown += 1;
          }
          continue;
        }
        const left = deadline - nowMs();
        if (!lookups || left < MIN_LOOKUP_BUDGET_MS) {
          counts.unknown += 1;
          continue;
        }
        try {
          const found = await provider.getSet(set.setNum, { budgetMs: Math.min(LOOKUP_BUDGET_MS, left) });
          if (found !== null) await fill(set.setNum, found.themeId, found.topTheme);
          if (found === null || found.topTheme === null) counts.unknown += 1;
          else counts.filledByLookup += 1;
        } catch (error) {
          if (!(error instanceof CatalogueUnavailable)) throw error;
          // The client has logged it; the set keeps its null top-level theme for the next run.
          counts.unknown += 1;
          if (error.reason === 'refused-key') lookups = false;
        }
      }
    }
    logger.info({ businessEvent: 'catalogue.themes.backfilled', ...counts }, `filled the top-level theme of ${counts.filledByName + counts.filledByLookup} set(s), ${counts.unknown} left unknown`);
    return counts;
  };
}

export const backfillThemes = createThemeBackfill({ provider: deployedCatalogueProvider });

/**
 * The migration step's call ([ITEM-13]): runs the backfill and logs a failure as a warning,
 * never throwing it, so a Rebrickable or database failure here never fails the step. The next
 * deploy tries again.
 */
export async function backfillThemesAfterMigrations(run: (input: z.input<typeof BackfillThemesInput>) => Promise<BackfillResult> = backfillThemes): Promise<void> {
  try {
    await run({});
  } catch (error) {
    const reason = error instanceof CatalogueUnavailable ? error.reason : error instanceof Error ? error.name : typeof error;
    logger.warn({ event: 'catalogue.themes.backfill.failed', reason }, 'the theme backfill failed; the migration step carries on, and the next deploy tries again');
  }
}
