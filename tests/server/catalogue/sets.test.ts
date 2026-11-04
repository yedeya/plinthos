import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createCatalogueService, FRESH_FOR_MS, looksLikeSetNum, MAX_RESULTS, normalizeSetNum, rankSets, SEARCH_BUDGET_MS } from '../../../src/server/catalogue/sets';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { CatalogueUnavailable, madeUpSet, standInCatalogue, type StandInCatalogue } from './fakes';

/**
 * The set lookup over `lego_set` and a stand-in catalogue ([CAT-1], [CAT-3], [CAT-5]). Every set
 * here is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const SET = madeUpSet('990010-1', { name: 'Made-up windmill' });

let fresh: FreshDatabase;
let admin: AdminContext;
let stand: StandInCatalogue;
let clock: number;

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
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  stand = standInCatalogue([SET]);
  clock = Date.UTC(2026, 10, 1);
});

const service = () => createCatalogueService({ provider: () => stand.provider, now: () => new Date(clock) });

async function stored(): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query('select * from lego_set order by set_num')).rows as Record<string, unknown>[];
}

describe('searchSets', () => {
  it('[CAT-1] puts the set whose number is the typed one first, even when the catalogue’s search ranks it low or misses it', async () => {
    // Twelve sets whose names hold the number, ranked by the catalogue before the set itself.
    const noise = Array.from({ length: 12 }, (_, i) => madeUpSet(`9${String(i).padStart(5, '0')}-1`, { name: `Made-up 990010 bundle ${i}` }));
    stand = standInCatalogue([...noise, SET, madeUpSet('990010-2', { name: 'Made-up windmill, second edition' })]);
    const result = await service().searchSets(admin, '990010');
    expect(result.status).toBe('ok');
    const nums = result.status === 'ok' ? result.sets.map((set) => set.setNum) : [];
    expect(nums[0]).toBe('990010-1');
    expect(nums[1]).toBe('990010-2');
    expect(nums).toHaveLength(MAX_RESULTS);
    expect(stand.calls).toEqual(['getSet 990010-1', 'searchSets 990010']);
  });

  it('[CAT-1] ranks by number first, then name, keeping the catalogue’s order within each', () => {
    const sets = [
      madeUpSet('990099-1', { name: 'Made-up 1029 tribute' }),
      madeUpSet('10290-1', { name: 'Made-up shed' }),
      madeUpSet('1029-1', { name: 'Made-up lamp' }),
      madeUpSet('990098-1', { name: 'Made-up kiosk' }),
    ];
    expect(rankSets('1029', sets).map((set) => set.setNum)).toEqual(['1029-1', '10290-1', '990099-1', '990098-1']);
    // A name query keeps the catalogue's order for names that hold it.
    expect(rankSets('made-up', sets).map((set) => set.setNum)).toEqual(['990099-1', '10290-1', '1029-1', '990098-1']);
  });

  it('[CAT-1] [CAT-2] spends at most the search budget in all, whatever the direct lookup comes to', async () => {
    // A stand-in whose lookup takes 2.5 s and then fails, as a slow catalogue does.
    const slow = standInCatalogue([SET]);
    const slowProvider: typeof slow.provider = {
      ...slow.provider,
      searchSets: (query, options) => slow.provider.searchSets(query, options),
      async getSet(setNum, options) {
        clock += 2_500;
        return slow.provider.getSet(setNum, options);
      },
    };
    const run = () => createCatalogueService({ provider: () => slowProvider, now: () => new Date(clock) });

    slow.failWith = new CatalogueUnavailable('timeout');
    expect(await run().searchSets(admin, '990010')).toEqual({ status: 'unavailable' });
    // The search got what was left after the failed lookup's 2.5 s, not a fresh 6 s.
    expect(slow.budgets).toEqual([2_500, SEARCH_BUDGET_MS - 2_500]);

    slow.failWith = undefined;
    slow.budgets.length = 0;
    await run().searchSets(admin, '99999');
    // A lookup that answered "not found" counts too.
    expect(slow.budgets).toEqual([2_500, SEARCH_BUDGET_MS - 2_500]);

    // A set fresh in the table costs the search nothing: no lookup, no catalogue search.
    await service().lookupSet('990010', { budgetMs: 1000 });
    stand.budgets.length = 0;
    await service().searchSets(admin, '990010');
    expect(stand.budgets).toEqual([]);
  });

  it('[CAT-1] looks up a set number directly only from four characters, and up to 40', async () => {
    expect(['102', 'R2', 'windmill', 'a'.repeat(41) + '1'].map(looksLikeSetNum)).toEqual([false, false, false, false]);
    expect(['1029', '10294', '10294-1', 'R2D2', 'sw0001a'].map(looksLikeSetNum)).toEqual([true, true, true, true, true]);
    // A 41-character alphanumeric query searches rather than failing the request.
    const result = await service().searchSets(admin, `${'9'.repeat(41)}`);
    expect(result.status).toBe('ok');
  });

  it('[CAT-5] answers the exact set, marked partial, when the search fails but the direct lookup found it', async () => {
    let lookups = 0;
    const flaky: typeof stand.provider = {
      ...stand.provider,
      getSet: async (setNum, options) => {
        lookups += 1;
        return stand.provider.getSet(setNum, options);
      },
      searchSets: async () => {
        throw new CatalogueUnavailable('timeout');
      },
    };
    const result = await createCatalogueService({ provider: () => flaky, now: () => new Date(clock) }).searchSets(admin, '990010');
    expect(lookups).toBe(1);
    expect(result).toEqual({ status: 'ok', sets: [expect.objectContaining({ setNum: '990010-1' })], partial: true });
  });

  it('[CAT-1] [CAT-3] answers a typed set number from lego_set alone, asking Rebrickable nothing, when its set is cached and fresh', async () => {
    stand.sets.set('990010-2', madeUpSet('990010-2', { name: 'Made-up windmill, second edition' }));
    await service().lookupSet('990010', { budgetMs: 1000 });
    await service().lookupSet('990010-2', { budgetMs: 1000 });
    stand.calls.length = 0;
    const result = await service().searchSets(admin, '990010');
    expect(result).toEqual({ status: 'ok', sets: [expect.objectContaining({ setNum: '990010-1' }), expect.objectContaining({ setNum: '990010-2' })] });
    expect(stand.calls).toEqual([]);

    // A stale row is no answer on its own: the catalogue is asked again, without a second lookup.
    clock += FRESH_FOR_MS + 1;
    await service().searchSets(admin, '990010');
    expect(stand.calls).toEqual(['searchSets 990010']);
  });

  it('[CAT-1] [CAT-3] reads lego_set first and merges it with the catalogue’s answer, one copy per set, the catalogue’s fresher fields kept', async () => {
    await service().lookupSet('990010', { budgetMs: 1000 });
    stand.sets.set(SET.setNum, { ...SET, name: 'Made-up windmill, renamed' });
    stand.sets.set('990011-1', madeUpSet('990011-1', { name: 'Made-up windmill shed' }));
    const result = await service().searchSets(admin, 'windmill');
    expect(result).toEqual({
      status: 'ok',
      sets: [expect.objectContaining({ setNum: '990010-1', name: 'Made-up windmill, renamed' }), expect.objectContaining({ setNum: '990011-1' })],
    });
    expect(stand.calls).toEqual(['getSet 990010-1', 'searchSets windmill']);
    // A name query matches the table's names and its set numbers by prefix, with LIKE's own
    // characters taken literally.
    stand.failWith = new CatalogueUnavailable('timeout');
    expect(await service().searchSets(admin, '9900')).toMatchObject({ status: 'ok', partial: true, sets: [{ setNum: '990010-1' }, { setNum: '990011-1' }] });
    expect(await service().searchSets(admin, '99%')).toEqual({ status: 'unavailable' });
  });

  it('[CAT-5] answers the sets lego_set holds, marked partial, when Rebrickable is down', async () => {
    await service().lookupSet('990010', { budgetMs: 1000 });
    for (const reason of ['timeout', 'rate-limited', 'refused-key', 'upstream'] as const) {
      stand.failWith = new CatalogueUnavailable(reason);
      expect(await service().searchSets(admin, 'windmill')).toEqual({ status: 'ok', sets: [expect.objectContaining({ setNum: '990010-1' })], partial: true });
    }
  });

  it('[CAT-2] stops asking the catalogue for a search whose request was aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: (AbortSignal | undefined)[] = [];
    const watching: typeof stand.provider = {
      ...stand.provider,
      getSet: async (setNum, options) => {
        seen.push(options.signal);
        return stand.provider.getSet(setNum, options);
      },
      searchSets: async (query, options) => {
        seen.push(options.signal);
        return stand.provider.searchSets(query, options);
      },
    };
    const run = createCatalogueService({ provider: () => watching, now: () => new Date(clock) });
    // This stand-in answers the lookup anyway; the real provider refuses an aborted call (`rebrickable.test.ts`).
    expect(await run.searchSets(admin, '990010', { signal: controller.signal })).toMatchObject({ status: 'ok', partial: true });
    // The lookup carries the signal, and the catalogue's search after it is never started.
    expect(seen).toEqual([controller.signal]);
  });

  it('[CAT-1] answers nothing and asks nothing for a query shorter than two characters', async () => {
    for (const query of ['', ' ', 'a', ' 9 ']) expect(await service().searchSets(admin, query)).toEqual({ status: 'ok', sets: [] });
    expect(stand.calls).toEqual([]);
  });

  it('[CAT-1] answers at most 10 sets, each with its number, name, theme, year, piece count and image', async () => {
    for (let n = 0; n < 15; n += 1) stand.sets.set(`99010${n}-1`, madeUpSet(`99010${n}-1`, { name: `Made-up tower ${n}` }));
    const result = await service().searchSets(admin, 'tower');
    if (result.status !== 'ok') throw new Error('unavailable');
    expect(result.sets).toHaveLength(MAX_RESULTS);
    for (const set of result.sets) expect(Object.keys(set).sort()).toEqual(['imageUrl', 'name', 'numParts', 'setNum', 'theme', 'themeId', 'topTheme', 'year']);
  });

  it('[CAT-1] is for the signed-in admin only', async () => {
    await expect(service().searchSets({ ...admin } as AdminContext, 'windmill')).rejects.toThrow(NotAdminError);
    expect(stand.calls).toEqual([]);
  });

  it('[CAT-3] a search by name always asks the catalogue, and stores every set it returns', async () => {
    await service().searchSets(admin, 'windmill');
    await service().searchSets(admin, 'windmill');
    expect(stand.calls).toEqual(['searchSets windmill', 'searchSets windmill']);
    expect(await stored()).toEqual([expect.objectContaining({ set_num: SET.setNum, name: SET.name, theme: SET.theme, year: SET.year, num_parts: SET.numParts, image_url: SET.imageUrl })]);
  });

  it('[CAT-5] answers unavailable, not an error, when the catalogue times out, rate-limits, refuses the key or fails', async () => {
    for (const reason of ['timeout', 'rate-limited', 'refused-key', 'upstream'] as const) {
      stand.failWith = new CatalogueUnavailable(reason);
      expect(await service().searchSets(admin, 'windmill')).toEqual({ status: 'unavailable' });
    }
    expect(await stored()).toEqual([]);
  });
});

describe('the theme of a stored set', () => {
  const SUB = madeUpSet('990020-1', { name: 'Made-up dojo', theme: 'Made-up dojos', themeId: 9913, topTheme: 'Made-up ninjas' });

  it('[ITEM-12] every set a lookup or a search stores carries its theme id and its top-level theme', async () => {
    stand.sets.set(SUB.setNum, SUB);
    await service().lookupSet(SET.setNum, { budgetMs: 1000 });
    await service().searchSets(admin, 'dojo');
    expect((await stored()).map(({ set_num, theme, theme_id, top_theme }) => ({ set_num, theme, theme_id, top_theme }))).toEqual([
      { set_num: SET.setNum, theme: SET.theme, theme_id: SET.themeId, top_theme: SET.topTheme },
      { set_num: SUB.setNum, theme: 'Made-up dojos', theme_id: 9913, top_theme: 'Made-up ninjas' },
    ]);
    // And answers them as stored, from the table.
    expect(await service().lookupSet(SUB.setNum, { budgetMs: 1000 })).toEqual(SUB);
    expect(stand.calls.filter((call) => call.startsWith('getSet'))).toEqual([`getSet ${SET.setNum}`]);
  });

  it('[ITEM-12] [CAT-3] a refetched row replaces its older theme id and top-level theme, a null one included', async () => {
    await fresh.client.query(
      `insert into lego_set (id, set_num, name, theme, year, num_parts, image_url, fetched_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), SET.setNum, SET.name, SET.theme, SET.year, SET.numParts, SET.imageUrl, new Date(clock - FRESH_FOR_MS - 1000)],
    );
    expect(await service().lookupSet(SET.setNum, { budgetMs: 1000 })).toEqual(SET);
    expect(await stored()).toEqual([expect.objectContaining({ theme_id: SET.themeId, top_theme: SET.topTheme })]);

    // Rebrickable moved the set; and later couldn't read the new theme's root.
    stand.sets.set(SET.setNum, { ...SET, theme: 'Made-up spinners', themeId: 9912, topTheme: 'Made-up ninjas' });
    clock += FRESH_FOR_MS + 1000;
    await service().lookupSet(SET.setNum, { budgetMs: 1000 });
    expect(await stored()).toEqual([expect.objectContaining({ theme: 'Made-up spinners', theme_id: 9912, top_theme: 'Made-up ninjas' })]);
    stand.sets.set(SET.setNum, { ...SET, themeId: 9911, topTheme: null });
    await service().searchSets(admin, 'windmill');
    expect(await stored()).toEqual([expect.objectContaining({ theme_id: 9911, top_theme: null })]);
  });
});

describe('lookupSet', () => {
  it('[CAT-3] reads a set fetched in the last 30 days from the table and asks the catalogue nothing', async () => {
    expect(await service().lookupSet(SET.setNum, { budgetMs: 1000 })).toEqual(SET);
    expect(stand.calls).toEqual([`getSet ${SET.setNum}`]);
    clock += FRESH_FOR_MS - 1000;
    expect(await service().lookupSet(SET.setNum, { budgetMs: 1000 })).toEqual(SET);
    expect(stand.calls).toHaveLength(1);
  });

  it('[CAT-3] fetches a set older than 30 days again and stores the new answer', async () => {
    await service().lookupSet(SET.setNum, { budgetMs: 1000 });
    stand.sets.set(SET.setNum, { ...SET, numParts: 456 });
    clock += FRESH_FOR_MS + 1000;
    expect((await service().lookupSet(SET.setNum, { budgetMs: 1000 }))?.numParts).toBe(456);
    expect(stand.calls).toHaveLength(2);
    expect(await stored()).toEqual([expect.objectContaining({ num_parts: 456, fetched_at: new Date(clock) })]);
  });

  it('[CAT-3] normalizes a set number without its variant: 990010 is looked up and stored as 990010-1, and nothing is re-cased', async () => {
    expect(await service().lookupSet(' 990010 ', { budgetMs: 1000 })).toEqual(SET);
    expect(stand.calls).toEqual(['getSet 990010-1']);
    expect((await stored()).map((row) => row.set_num)).toEqual(['990010-1']);
    expect(normalizeSetNum('10294')).toBe('10294-1');
    expect(normalizeSetNum('10294-2')).toBe('10294-2');
    expect(normalizeSetNum('abc-x')).toBe('abc-x-1');
    expect(normalizeSetNum('Mini-12')).toBe('Mini-12');
  });

  it('[CAT-3] answers null for a set the catalogue doesn’t know, and stores nothing', async () => {
    expect(await service().lookupSet('999999-9', { budgetMs: 1000 })).toBeNull();
    expect(await stored()).toEqual([]);
  });

  it('[CAT-5] throws when the catalogue can’t answer and the table holds no row; answers an older row when it does', async () => {
    stand.failWith = new CatalogueUnavailable('timeout');
    await expect(service().lookupSet(SET.setNum, { budgetMs: 1000 })).rejects.toBeInstanceOf(CatalogueUnavailable);
    stand.failWith = undefined;
    await service().lookupSet(SET.setNum, { budgetMs: 1000 });
    clock += FRESH_FOR_MS + 1000;
    stand.failWith = new CatalogueUnavailable('rate-limited');
    expect(await service().lookupSet(SET.setNum, { budgetMs: 1000 })).toEqual(SET);
  });

  it('[CAT-3] passes the caller’s budget to the catalogue', async () => {
    await service().lookupSet(SET.setNum, { budgetMs: 1234 });
    expect(stand.budgets).toEqual([1234]);
  });
});
