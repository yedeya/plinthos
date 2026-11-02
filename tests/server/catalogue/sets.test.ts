import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import type { CatalogueSet } from '../../../src/server/catalogue/rebrickable';
import { createCatalogueService, FRESH_FOR_MS, normalizeSetNum } from '../../../src/server/catalogue/sets';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { fakeCatalogue, MADE_UP_SETS, type FakeCatalogue } from './fakes';

const [LIGHTHOUSE] = MADE_UP_SETS as [CatalogueSet, ...CatalogueSet[]];

/**
 * The set lookup over `lego_set` and a stand-in catalogue provider (#133, [CAT-1], [CAT-3],
 * [CAT-5]). Rebrickable is never called: the provider is `./fakes.ts`'s.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const NOW = new Date('2026-11-02T10:00:00.000Z');

let fresh: FreshDatabase;
let admin: AdminContext;
let catalogue: FakeCatalogue;
let now: Date;

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
  catalogue = fakeCatalogue();
  now = NOW;
});

function service() {
  return createCatalogueService({ provider: () => catalogue.provider, now: () => now });
}

async function stored(): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query('select set_num, name, theme, year, num_parts, image_url, fetched_at from lego_set order by set_num')).rows as Record<string, unknown>[];
}

describe('searchSets', () => {
  it('[CAT-1] answers a query shorter than two characters with nothing, calling neither Rebrickable nor the database', async () => {
    const before = state.db;
    state.db = new Proxy({}, { get: () => { throw new Error('the database was called'); } });
    try {
      for (const query of ['', ' ', 'a', ' 9 ']) expect(await service().searchSets(admin, query), JSON.stringify(query)).toEqual({ status: 'ok', sets: [] });
    } finally {
      state.db = before;
    }
    expect(catalogue.calls).toEqual([]);
  });

  it('[CAT-1] returns at most 10 sets, each with its set number, name, theme, year, piece count and stock image URL', async () => {
    catalogue.searchResults = Array.from({ length: 14 }, (_, index) => ({ ...LIGHTHOUSE, setNum: `9100${index}-1`, name: `Made-up Tower ${index}` }));
    const answer = await service().searchSets(admin, 'tower');
    expect(answer.status).toBe('ok');
    const sets = answer.status === 'ok' ? answer.sets : [];
    expect(sets).toHaveLength(10);
    expect(Object.keys(sets[0] ?? {}).sort()).toEqual(['imageUrl', 'name', 'numParts', 'setNum', 'theme', 'year']);
    expect(sets[0]).toEqual({ setNum: '91000-1', name: 'Made-up Tower 0', theme: 'Made-up Icons', year: 2021, numParts: 2101, imageUrl: 'https://cdn.example.test/sets/90001-1.jpg' });
  });

  it('[CAT-1] is a service function only an AdminContext from the session check can call, refused before the catalogue is asked', async () => {
    const forged = { sessionKey: randomUUID(), requestId: randomUUID() } as unknown as AdminContext;
    await expect(service().searchSets(forged, 'lighthouse')).rejects.toThrow(NotAdminError);
    expect(catalogue.calls).toEqual([]);
  });

  it('[CAT-3] a search by name always asks Rebrickable and stores every set it returns, with when it was fetched', async () => {
    await service().searchSets(admin, 'made-up');
    expect(catalogue.calls).toEqual(['search made-up']);
    expect(await stored()).toEqual(
      MADE_UP_SETS.map((set) => ({ set_num: set.setNum, name: set.name, theme: set.theme, year: set.year, num_parts: set.numParts, image_url: set.imageUrl, fetched_at: NOW })),
    );

    // The same search a minute later asks again, and refreshes the stored rows.
    now = new Date(NOW.getTime() + 60_000);
    catalogue.searchResults = [{ ...LIGHTHOUSE, name: 'Made-up Lighthouse, renamed' }];
    await service().searchSets(admin, 'made-up');
    expect(catalogue.calls).toEqual(['search made-up', 'search made-up']);
    const rows = await stored();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ set_num: '90001-1', name: 'Made-up Lighthouse, renamed', fetched_at: now });
  });

  it('[CAT-3] a search by a set number fetched in the last 30 days reads the table and makes no Rebrickable request', async () => {
    await service().lookupSet('90001-1');
    catalogue.calls.length = 0;
    now = new Date(NOW.getTime() + FRESH_FOR_MS - 60_000);
    for (const query of ['90001-1', '90001', ' 90001-1 ']) {
      expect(await service().searchSets(admin, query), query).toEqual({ status: 'ok', sets: [MADE_UP_SETS[0]] });
    }
    expect(catalogue.calls).toEqual([]);
  });

  it('[CAT-5] answers unavailable, never an error, when Rebrickable fails, times out or refuses the key, and stores nothing', async () => {
    for (const reason of ['timeout', 'rate-limited', 'refused-key', 'upstream'] as const) {
      catalogue.failWith = reason;
      expect(await service().searchSets(admin, 'lighthouse'), reason).toEqual({ status: 'unavailable' });
    }
    expect(await stored()).toEqual([]);
  });

  it('[CAT-5] answers unavailable when the provider cannot even be built, as with no key linked', async () => {
    const broken = createCatalogueService({
      provider: () => {
        throw new Error('made-up: no provider');
      },
      now: () => now,
    });
    expect(await broken.searchSets(admin, 'lighthouse')).toEqual({ status: 'unavailable' });
  });
});

describe('lookupSet', () => {
  it('[CAT-3] stores a looked-up set in lego_set, keyed by its set number, and reads it from there for 30 days', async () => {
    expect(await service().lookupSet('90002-1')).toEqual(MADE_UP_SETS[1]);
    expect(catalogue.calls).toEqual(['getSet 90002-1']);
    expect(await stored()).toEqual([
      { set_num: '90002-1', name: 'Made-up Harbour', theme: 'Made-up Icons', year: 2022, num_parts: 1302, image_url: 'https://cdn.example.test/sets/90002-1.jpg', fetched_at: NOW },
    ]);
    now = new Date(NOW.getTime() + FRESH_FOR_MS - 1);
    expect(await service().lookupSet('90002-1')).toEqual(MADE_UP_SETS[1]);
    expect(catalogue.calls).toEqual(['getSet 90002-1']);
    await expect(fresh.client.query(`insert into lego_set (id, set_num, name, theme, year, num_parts, fetched_at) values ($1, '90002-1', 'x', 'x', 1, 1, now())`, [randomUUID()])).rejects.toThrow(
      /duplicate key|unique/,
    );
  });

  it('[CAT-3] asks again once the stored row is older than 30 days, and keeps the stored row when that fails', async () => {
    await service().lookupSet('90002-1');
    now = new Date(NOW.getTime() + FRESH_FOR_MS + 1);
    await service().lookupSet('90002-1');
    expect(catalogue.calls).toEqual(['getSet 90002-1', 'getSet 90002-1']);
    expect((await stored())[0]).toMatchObject({ fetched_at: now });

    now = new Date(now.getTime() + FRESH_FOR_MS + 1);
    catalogue.failWith = 'timeout';
    expect(await service().lookupSet('90002-1')).toEqual(MADE_UP_SETS[1]);
  });

  it('[CAT-3] answers null for a set Rebrickable does not know, and stores nothing', async () => {
    expect(await service().lookupSet('99999-1')).toBeNull();
    expect(await stored()).toEqual([]);
  });

  it('[CAT-3] reads a set number without its variant as the first variant', () => {
    expect(normalizeSetNum(' 90001 ')).toBe('90001-1');
    expect(normalizeSetNum('90001-2')).toBe('90001-2');
    expect(normalizeSetNum('made-up-1')).toBe('made-up-1');
  });
});
