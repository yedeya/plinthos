import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { applyMigrations } from '../../../src/db/migrate';
import type { CatalogueProvider, CatalogueTheme } from '../../../src/server/catalogue/rebrickable';
import { backfillThemesAfterMigrations, createThemeBackfill } from '../../../src/server/catalogue/themes';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureSharedLogger } from '../capture';
import { CatalogueUnavailable, madeUpSet, standInCatalogue, type StandInCatalogue } from './fakes';

/**
 * The theme backfill over `lego_set`, `collection_item` and a stand-in catalogue ([ITEM-13]).
 * Every set and theme here is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

/** A made-up tree: one name under two parents, and one two levels down. */
const TREE: CatalogueTheme[] = [
  { id: 9911, parentId: null, name: 'Made-up ninjas' },
  { id: 9912, parentId: 9911, name: 'Made-up spinners' },
  { id: 9913, parentId: 9912, name: 'Made-up dojos' },
  { id: 9914, parentId: 9911, name: 'Made-up battle packs' },
  { id: 9921, parentId: null, name: 'Made-up seasonal' },
  { id: 9923, parentId: 9921, name: 'Made-up battle packs' },
];

let fresh: FreshDatabase;
let stand: StandInCatalogue;
let clock: number;
let captured: ReturnType<typeof captureSharedLogger>;

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  state.db = fresh.db;
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('truncate lego_set cascade');
  stand = standInCatalogue([], TREE);
  clock = Date.UTC(2026, 10, 4);
  captured = captureSharedLogger();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const backfill = (provider: () => CatalogueProvider = () => stand.provider) => createThemeBackfill({ provider, now: () => new Date(clock) });

/** A set stored as before the theme columns, with its leaf theme's name only, and an item naming it unless `owned` is false. */
async function storedSet(setNum: string, theme: string, options: { readonly owned?: boolean; readonly topTheme?: string } = {}): Promise<void> {
  await fresh.client.query(`insert into lego_set (id, set_num, name, theme, top_theme, year, num_parts, fetched_at) values ($1, $2, $3, $4, $5, 2001, 10, now())`, [
    randomUUID(),
    setNum,
    `Made-up set ${setNum}`,
    theme,
    options.topTheme ?? null,
  ]);
  if (options.owned === false) return;
  for (let copy = 0; copy < 2; copy += 1) {
    await fresh.client.query(
      `insert into collection_item (id, set_num, condition, complete, has_instructions, description, quantity, storage_location, version, created_at, updated_at) values ($1, $2, 'SEALED', true, true, '', 1, '', 1, now(), now())`,
      [randomUUID(), setNum],
    );
  }
}

async function themes(): Promise<Record<string, { theme_id: number | null; top_theme: string | null }>> {
  const { rows } = await fresh.client.query<{ set_num: string; theme_id: number | null; top_theme: string | null }>('select set_num, theme_id, top_theme from lego_set order by set_num');
  return Object.fromEntries(rows.map(({ set_num, theme_id, top_theme }) => [set_num, { theme_id, top_theme }]));
}

const backfilled = () => captured.events().filter((event) => event.businessEvent === 'catalogue.themes.backfilled');

describe('backfillThemes', () => {
  it('[ITEM-13] maps a name that occurs once in the tree with no request but the theme list, and looks any other set up by its number', async () => {
    await storedSet('990101-1', 'Made-up dojos');
    await storedSet('990102-1', 'Made-up battle packs');
    await storedSet('990103-1', 'Made-up retired theme');
    await storedSet('990104-1', 'Made-up ninjas');
    stand.sets.set('990102-1', madeUpSet('990102-1', { theme: 'Made-up battle packs', themeId: 9923, topTheme: 'Made-up seasonal' }));

    expect(await backfill()({})).toEqual({ filledByName: 2, filledByLookup: 1, unknown: 1 });
    // The theme list once; then one lookup each for the name under two parents and the name nowhere.
    expect(stand.calls).toEqual(['listThemes', 'getSet 990102-1', 'getSet 990103-1']);
    expect(await themes()).toEqual({
      '990101-1': { theme_id: 9913, top_theme: 'Made-up ninjas' },
      '990102-1': { theme_id: 9923, top_theme: 'Made-up seasonal' },
      '990103-1': { theme_id: null, top_theme: null },
      // A top-level theme is its own.
      '990104-1': { theme_id: 9911, top_theme: 'Made-up ninjas' },
    });
  });

  it('[ITEM-13] fills only a set an item names whose top-level theme is null', async () => {
    await storedSet('990111-1', 'Made-up dojos', { owned: false });
    await storedSet('990112-1', 'Made-up battle packs', { topTheme: 'Made-up kept' });
    await storedSet('990113-1', 'Made-up dojos');
    await fresh.client.query(
      `insert into collection_item (id, kind, name, condition, description, quantity, storage_location, version, created_at, updated_at) values ($1, 'OTHER', 'Made-up loose brick', 'SEALED', '', 1, '', 1, now(), now())`,
      [randomUUID()],
    );

    expect(await backfill()({})).toEqual({ filledByName: 1, filledByLookup: 0, unknown: 0 });
    expect(stand.calls).toEqual(['listThemes']);
    expect(await themes()).toEqual({
      '990111-1': { theme_id: null, top_theme: null },
      '990112-1': { theme_id: null, top_theme: 'Made-up kept' },
      '990113-1': { theme_id: 9913, top_theme: 'Made-up ninjas' },
    });
  });

  it('[ITEM-13] a set Rebrickable can’t answer for keeps a null top-level theme, and the next run tries it again', async () => {
    await storedSet('990121-1', 'Made-up battle packs');
    await storedSet('990122-1', 'Made-up battle packs');
    await storedSet('990123-1', 'Made-up dojos');
    const down = new Set(['990121-1']);
    const flaky = (): CatalogueProvider => ({
      ...stand.provider,
      getSet: (setNum, options) => (down.has(setNum) ? Promise.reject(new CatalogueUnavailable('timeout')) : stand.provider.getSet(setNum, options)),
    });
    stand.sets.set('990122-1', madeUpSet('990122-1', { themeId: 9914, topTheme: null }));

    expect(await backfill(flaky)({})).toEqual({ filledByName: 1, filledByLookup: 0, unknown: 2 });
    expect(await themes()).toMatchObject({ '990121-1': { top_theme: null }, '990122-1': { theme_id: 9914, top_theme: null } });

    down.clear();
    stand.calls.length = 0;
    stand.sets.set('990121-1', madeUpSet('990121-1', { themeId: 9914, topTheme: 'Made-up ninjas' }));
    stand.sets.set('990122-1', madeUpSet('990122-1', { themeId: 9923, topTheme: 'Made-up seasonal' }));
    expect(await backfill(flaky)({})).toEqual({ filledByName: 0, filledByLookup: 2, unknown: 0 });
    expect(stand.calls).toEqual(['listThemes', 'getSet 990121-1', 'getSet 990122-1']);
    expect(await themes()).toMatchObject({ '990121-1': { theme_id: 9914, top_theme: 'Made-up ninjas' }, '990122-1': { theme_id: 9923, top_theme: 'Made-up seasonal' } });
  });

  it('[ITEM-13] stops looking up once Rebrickable refuses the key, and once the run’s budget is spent', async () => {
    for (const setNum of ['990131-1', '990132-1', '990133-1']) await storedSet(setNum, 'Made-up battle packs');
    const refusing = (): CatalogueProvider => ({ ...stand.provider, getSet: async (setNum) => (stand.calls.push(`getSet ${setNum}`), Promise.reject(new CatalogueUnavailable('refused-key'))) });
    expect(await backfill(refusing)({})).toEqual({ filledByName: 0, filledByLookup: 0, unknown: 3 });
    expect(stand.calls).toEqual(['listThemes', 'getSet 990131-1']);

    stand.calls.length = 0;
    stand.budgets.length = 0;
    const slow = (): CatalogueProvider => ({
      ...stand.provider,
      getSet: async (setNum, options) => {
        const answer = await stand.provider.getSet(setNum, options);
        clock += 29_000;
        return answer;
      },
    });
    expect(await backfill(slow)({ budgetMs: 30_000 })).toEqual({ filledByName: 0, filledByLookup: 0, unknown: 3 });
    // Each call gets what is left of the run's budget, at most its own share; a call with too little left is not made.
    expect(stand.calls).toEqual(['listThemes', 'getSet 990131-1']);
    expect(stand.budgets.every((budget) => budget <= 30_000)).toBe(true);
  });

  it('[ITEM-13] a run with nothing to fill makes no request', async () => {
    await storedSet('990141-1', 'Made-up dojos', { topTheme: 'Made-up ninjas' });
    await storedSet('990142-1', 'Made-up dojos', { owned: false });
    expect(await backfill()({})).toEqual({ filledByName: 0, filledByLookup: 0, unknown: 0 });
    expect(stand.calls).toEqual([]);
    expect(backfilled()).toEqual([expect.objectContaining({ level: 'info', filledByName: 0, filledByLookup: 0, unknown: 0 })]);
  });

  it('[ITEM-13] logs catalogue.themes.backfilled with how many sets it filled by name, filled by lookup, and left unknown', async () => {
    await storedSet('990151-1', 'Made-up dojos');
    await storedSet('990152-1', 'Made-up battle packs');
    await storedSet('990153-1', 'Made-up retired theme');
    stand.sets.set('990152-1', madeUpSet('990152-1', { themeId: 9914, topTheme: 'Made-up ninjas' }));
    await backfill()({});
    expect(backfilled()).toEqual([expect.objectContaining({ level: 'info', filledByName: 1, filledByLookup: 1, unknown: 1 })]);
    // No set number, theme or name in the line: the counts are the whole of it.
    expect(captured.lines.join('')).not.toMatch(/9901|Made-up/);
  });

  it('[ITEM-13] is a typed service function whose input zod checks', async () => {
    const run = backfill();
    await expect(run({ budgetMs: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(run({ budgetMs: 'soon' } as never)).rejects.toBeInstanceOf(ZodError);
    await expect(run({ setNums: ['990101-1'] } as never)).rejects.toBeInstanceOf(ZodError);
    expect(stand.calls).toEqual([]);
  });

  it('[ITEM-13] a theme list Rebrickable can’t give writes nothing and throws, for the migration step to log', async () => {
    await storedSet('990161-1', 'Made-up dojos');
    stand.failWith = new CatalogueUnavailable('rate-limited');
    await expect(backfill()({})).rejects.toBeInstanceOf(CatalogueUnavailable);
    expect(await themes()).toEqual({ '990161-1': { theme_id: null, top_theme: null } });
  });
});

describe('the migration step’s backfill', () => {
  it('[ITEM-13] logs a failed backfill and never fails the migration step', async () => {
    for (const failure of [new CatalogueUnavailable('refused-key'), new Error('the database refused')]) {
      await expect(backfillThemesAfterMigrations(() => Promise.reject(failure))).resolves.toBeUndefined();
    }
    expect(captured.events().filter((event) => event.event === 'catalogue.themes.backfill.failed')).toEqual([
      expect.objectContaining({ level: 'warn', reason: 'refused-key' }),
      expect.objectContaining({ level: 'warn', reason: 'Error' }),
    ]);
    // A backfill that runs answers what it filled.
    await expect(backfillThemesAfterMigrations(async () => ({ filledByName: 1, filledByLookup: 0, unknown: 0 }))).resolves.toBeUndefined();
  });
});
