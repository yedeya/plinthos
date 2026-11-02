import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createCatalogueService, FRESH_FOR_MS, MAX_RESULTS, normalizeSetNum } from '../../../src/server/catalogue/sets';
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
  it('[CAT-1] answers nothing and asks nothing for a query shorter than two characters', async () => {
    for (const query of ['', ' ', 'a', ' 9 ']) expect(await service().searchSets(admin, query)).toEqual({ status: 'ok', sets: [] });
    expect(stand.calls).toEqual([]);
  });

  it('[CAT-1] answers at most 10 sets, each with its number, name, theme, year, piece count and image', async () => {
    for (let n = 0; n < 15; n += 1) stand.sets.set(`99010${n}-1`, madeUpSet(`99010${n}-1`, { name: `Made-up tower ${n}` }));
    const result = await service().searchSets(admin, 'tower');
    if (result.status !== 'ok') throw new Error('unavailable');
    expect(result.sets).toHaveLength(MAX_RESULTS);
    for (const set of result.sets) expect(Object.keys(set).sort()).toEqual(['imageUrl', 'name', 'numParts', 'setNum', 'theme', 'year']);
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
