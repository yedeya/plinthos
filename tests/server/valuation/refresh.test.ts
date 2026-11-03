import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createValuationService, FRESH_FOR_MS, MIN_REQUEST_MS, UNREACHABLE_AFTER, UNKNOWN_ITEM } from '../../../src/server/valuation/refresh';
import { readCollectionValues } from '../../../src/server/valuation/values';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { standInPrices, type FakeAnswer } from './fakes';

/**
 * `refreshPrices`, `setValueOverride`, `saveValueAdjustments` and `readCollectionValues` over the
 * test database and a stand-in BrickLink (brief #207, Issue B, [VAL-3] to [VAL-7]). Every set,
 * minifigure, price and item here is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let capture: ReturnType<typeof captureLogger>;

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  const url = new URL(readDatabaseUrl());
  url.pathname = `/${fresh.client.database ?? ''}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  state.db = drizzle(pool, { schema });
});
afterAll(async () => {
  await pool.end();
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('truncate price_quote, photo, collection_item, lego_set, parts_lot, parts_import cascade');
  await fresh.client.query('update catalogue_settings set adjust_used_with_box_pct = 0, adjust_used_no_box_pct = 0');
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  capture = captureLogger();
});

const AT = new Date('2026-11-01T09:00:00.000Z');

/** Stores an item straight in the table, as `saveItem` would have; answers its id. */
async function item(fields: Partial<typeof schema.collectionItem.$inferInsert> & { kind?: 'SET' | 'MINIFIG' | 'BULK' | 'OTHER' }): Promise<string> {
  const id = randomUUID();
  const kind = fields.kind ?? 'SET';
  if (kind === 'SET') {
    const setNum = fields.setNum ?? '990001-1';
    await fresh.db.insert(schema.legoSet).values({ setNum, name: `Made-up ${setNum}`, theme: 'Made-up', year: 2001, numParts: 10, fetchedAt: AT }).onConflictDoNothing();
  }
  await fresh.db.insert(schema.collectionItem).values({
    id,
    kind,
    setNum: kind === 'SET' ? (fields.setNum ?? '990001-1') : null,
    name: kind === 'SET' ? null : (fields.name ?? 'Made-up figure'),
    condition: 'SEALED',
    description: '',
    quantity: 1,
    storageLocation: 'made-up shelf',
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  });
  return id;
}

function service(answers: Readonly<Record<string, FakeAnswer>>, options: { budgetMs?: number; requestMs?: number; start?: Date; currency?: string } = {}) {
  const prices = standInPrices(answers, options);
  const valuation = createValuationService({
    provider: () => prices.provider,
    now: prices.now,
    log: capture.log,
    currency: () => options.currency ?? 'EUR',
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  });
  return { ...valuation, prices };
}

async function quotes() {
  return fresh.db.select().from(schema.priceQuote);
}

describe('refreshPrices', () => {
  it('[VAL-3] refuses anyone but the signed-in admin, before it asks BrickLink anything', async () => {
    await item({ setNum: '990001-1' });
    const { refreshPrices, prices } = service({});
    await expect(refreshPrices({} as AdminContext, {})).rejects.toThrow(NotAdminError);
    await expect(refreshPrices(admin, { all: 'yes' } as never)).rejects.toThrow();
    expect(prices.asked).toEqual([]);
  });

  it('[VAL-2] [VAL-3] asks once for each set by condition and each minifigure with a reference number, and never for a bulk lot or other item', async () => {
    await item({ setNum: '990001-1', condition: 'SEALED' });
    await item({ setNum: '990001-1', condition: 'SEALED', quantity: 3 });
    await item({ setNum: '990001-1', condition: 'USED_WITH_BOX' });
    await item({ setNum: '990002-1', condition: 'USED_NO_BOX' });
    await item({ kind: 'MINIFIG', refNo: 'mu0001', condition: 'USED_NO_BOX' });
    await item({ kind: 'MINIFIG', refNo: null, condition: 'USED_NO_BOX' });
    await item({ kind: 'BULK', refNo: 'mu-bulk', condition: 'USED_NO_BOX' });
    await item({ kind: 'OTHER', refNo: 'mu-gear', condition: 'SEALED' });
    const { refreshPrices, prices } = service({ 'SET 990001-1 N': { average: 100 }, 'SET 990001-1 U': { average: 60 }, 'SET 990002-1 U': { average: 20 }, 'MINIFIG mu0001 U': { average: 4 } });
    const result = await refreshPrices(admin, {});
    expect(result).toMatchObject({ done: 4, failed: 0, left: 0 });
    expect(result.stopped).toBeUndefined();
    expect([...prices.asked].sort()).toEqual(['MINIFIG mu0001 U', 'SET 990001-1 N', 'SET 990001-1 U', 'SET 990002-1 U']);
    expect((await quotes()).map((quote) => `${quote.itemType} ${quote.itemNo} ${quote.newOrUsed} ${quote.average} ${quote.source}`).sort()).toEqual([
      'MINIFIG mu0001 U 4 bricklink',
      'SET 990001-1 N 100 bricklink',
      'SET 990001-1 U 60 bricklink',
      'SET 990002-1 U 20 bricklink',
    ]);
    expect(capture.events().find((event) => event.businessEvent === 'price.refreshed')).toMatchObject({ done: 4, failed: 0, left: 0, requestId: admin.requestId });
  });

  it('[VAL-3] skips a quote fetched in the last 7 days, unless the owner asks for every price', async () => {
    await item({ setNum: '990001-1' });
    const first = service({ 'SET 990001-1 N': { average: 100 } });
    await first.refreshPrices(admin, {});
    const again = service({ 'SET 990001-1 N': { average: 110 } }, { start: new Date(first.prices.now().getTime() + FRESH_FOR_MS - 60_000) });
    expect(await again.refreshPrices(admin, {})).toMatchObject({ done: 0, left: 0, failed: 0 });
    expect(again.prices.asked).toEqual([]);
    expect(await again.refreshPrices(admin, { all: true })).toMatchObject({ done: 1, left: 0 });
    expect((await quotes())[0]?.average).toBe(110);
    const stale = service({ 'SET 990001-1 N': { average: 120 } }, { start: new Date(again.prices.now().getTime() + FRESH_FOR_MS + 60_000) });
    expect(await stale.refreshPrices(admin, {})).toMatchObject({ done: 1, left: 0 });
    expect((await quotes())[0]?.average).toBe(120);
  });

  it('[VAL-3] fits its budget, oldest first, answers what is left, and a call with the run’s start finishes the rest without asking twice', async () => {
    const sets = ['990001-1', '990002-1', '990003-1', '990004-1', '990005-1'];
    for (const setNum of sets) await item({ setNum });
    const answers = Object.fromEntries(sets.map((setNum) => [`SET ${setNum} N`, { average: 10 }]));
    // The oldest quote is the one asked for longest ago; never-asked ones come before every other.
    const old = new Date('2026-10-01T00:00:00.000Z');
    await fresh.db.insert(schema.priceQuote).values([
      { itemType: 'SET', itemNo: '990001-1', newOrUsed: 'N', average: 5, sampleSize: 1, currency: 'EUR', source: 'bricklink', fetchedAt: old, attemptedAt: new Date('2026-10-02T00:00:00.000Z') },
      { itemType: 'SET', itemNo: '990002-1', newOrUsed: 'N', average: 5, sampleSize: 1, currency: 'EUR', source: 'bricklink', fetchedAt: old, attemptedAt: old },
    ]);
    // Each request takes 1 s of a 2.5 s budget, and one starts only with MIN_REQUEST_MS left: one a call.
    const { refreshPrices, prices } = service(answers, { budgetMs: MIN_REQUEST_MS + 500, requestMs: 1_000 });
    const first = await refreshPrices(admin, {});
    expect(first).toMatchObject({ done: 1, left: 4, failed: 0 });
    let runStartedAt = first.runStartedAt;
    let left = first.left;
    for (let calls = 0; left > 0 && calls < 10; calls++) {
      const next = await refreshPrices(admin, { runStartedAt });
      expect(next.left).toBeLessThan(left);
      left = next.left;
      runStartedAt = next.runStartedAt;
    }
    expect(left).toBe(0);
    expect(prices.asked).toEqual(['SET 990003-1 N', 'SET 990004-1 N', 'SET 990005-1 N', 'SET 990002-1 N', 'SET 990001-1 N']);
    // Every request was given what was left of the call's budget, and no more.
    for (const budget of prices.budgets) expect(budget).toBeLessThanOrEqual(MIN_REQUEST_MS + 500);
    // A whole run with every price, a minute later: each asked for once, however many calls it takes.
    prices.advance(60_000);
    const all = await refreshPrices(admin, { all: true });
    let allLeft = all.left;
    for (let calls = 0; allLeft > 0 && calls < 10; calls++) allLeft = (await refreshPrices(admin, { all: true, runStartedAt: all.runStartedAt })).left;
    expect(prices.asked.slice(5).sort()).toEqual(sets.map((setNum) => `SET ${setNum} N`).sort());
  });

  it('[VAL-4] records an unknown item or one failed request on its quote, goes on with the rest, and changes no price it had', async () => {
    await item({ setNum: '990001-1' });
    await item({ setNum: '990002-1' });
    await item({ setNum: '990003-1' });
    const fetchedAt = new Date('2026-09-01T00:00:00.000Z');
    await fresh.db.insert(schema.priceQuote).values({ itemType: 'SET', itemNo: '990002-1', newOrUsed: 'N', average: 42.5, sampleSize: 7, currency: 'EUR', source: 'bricklink', fetchedAt, attemptedAt: fetchedAt });
    const { refreshPrices } = service({ 'SET 990001-1 N': null, 'SET 990002-1 N': { refuse: 'timeout' }, 'SET 990003-1 N': { average: 30 } });
    expect(await refreshPrices(admin, {})).toMatchObject({ done: 1, failed: 2, left: 0 });
    const byNo = new Map((await quotes()).map((quote) => [quote.itemNo, quote]));
    expect(byNo.get('990001-1')).toMatchObject({ average: null, lastError: UNKNOWN_ITEM, fetchedAt: null });
    expect(byNo.get('990002-1')).toMatchObject({ average: 42.5, sampleSize: 7, lastError: 'timeout', fetchedAt });
    expect(byNo.get('990003-1')).toMatchObject({ average: 30, lastError: null });
  });

  it('[VAL-4] stops on a refused key, says so, logs price.refresh.failed with no secret, and keeps every price', async () => {
    await item({ setNum: '990001-1' });
    await item({ setNum: '990002-1' });
    const fetchedAt = new Date('2026-09-01T00:00:00.000Z');
    await fresh.db.insert(schema.priceQuote).values({ itemType: 'SET', itemNo: '990001-1', newOrUsed: 'N', average: 42.5, sampleSize: 7, currency: 'EUR', source: 'bricklink', fetchedAt, attemptedAt: fetchedAt });
    const before = await quotes();
    const { refreshPrices, prices } = service({ 'SET 990001-1 N': { refuse: 'refused-key' }, 'SET 990002-1 N': { refuse: 'refused-key' } });
    const result = await refreshPrices(admin, {});
    expect(result).toMatchObject({ done: 0, failed: 0, left: 2, stopped: 'refused-key' });
    expect(prices.asked).toHaveLength(1);
    expect(await quotes()).toEqual(before);
    const failed = capture.events().find((event) => event.businessEvent === 'price.refresh.failed');
    expect(failed).toMatchObject({ reason: 'refused-key', done: 0, left: 2 });
    expect(capture.events().some((event) => event.businessEvent === 'price.refreshed')).toBe(false);
    expect(capture.lines.join('\n')).not.toMatch(/consumer|token|secret|oauth/i);
  });

  it('[VAL-4] stops as unreachable when request after request fails with no answer between them', async () => {
    const sets = ['990001-1', '990002-1', '990003-1', '990004-1', '990005-1'];
    for (const setNum of sets) await item({ setNum });
    const { refreshPrices, prices } = service(Object.fromEntries(sets.map((setNum) => [`SET ${setNum} N`, { refuse: 'upstream' as const }])));
    const result = await refreshPrices(admin, {});
    expect(result).toMatchObject({ done: 0, failed: UNREACHABLE_AFTER, left: sets.length - UNREACHABLE_AFTER, stopped: 'unreachable' });
    expect(prices.asked).toHaveLength(UNREACHABLE_AFTER);
    expect(capture.events().find((event) => event.businessEvent === 'price.refresh.failed')).toMatchObject({ reason: 'unreachable' });
  });

  it('[VAL-4] tries a failed request again at the next run, but an item BrickLink doesn’t know only once it is stale', async () => {
    await item({ setNum: '990001-1' });
    await item({ setNum: '990002-1' });
    const first = service({ 'SET 990001-1 N': null, 'SET 990002-1 N': { refuse: 'timeout' } });
    await first.refreshPrices(admin, {});
    const next = service({ 'SET 990001-1 N': { average: 1 }, 'SET 990002-1 N': { average: 2 } }, { start: new Date(first.prices.now().getTime() + 60_000) });
    expect(await next.refreshPrices(admin, {})).toMatchObject({ done: 1, left: 0 });
    expect(next.prices.asked).toEqual(['SET 990002-1 N']);
  });
});

describe('the values', () => {
  it('[VAL-5] [VAL-6] [VAL-7] readCollectionValues answers each item’s value with its source and date, the parts’ value and the currency', async () => {
    const sealed = await item({ setNum: '990001-1', condition: 'SEALED', quantity: 2 });
    const boxed = await item({ setNum: '990001-1', condition: 'USED_WITH_BOX' });
    const figure = await item({ kind: 'MINIFIG', refNo: 'mu0001', condition: 'USED_NO_BOX', quantity: 3 });
    const bulk = await item({ kind: 'BULK', condition: 'USED_NO_BOX' });
    const valuedBulk = await item({ kind: 'BULK', condition: 'USED_NO_BOX', manualValueOverride: 15, manualValueCurrency: 'EUR' });
    const { refreshPrices, saveValueAdjustments, prices } = service({ 'SET 990001-1 N': { average: 100 }, 'SET 990001-1 U': { average: 60 }, 'MINIFIG mu0001 U': { average: 4.5 } });
    await refreshPrices(admin, {});
    await saveValueAdjustments(admin, { usedWithBoxPct: -10, usedNoBoxPct: 20 });
    const importId = randomUUID();
    await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BSX', currency: 'USD', importedAt: AT, lots: 2, quantity: 30, totalValue: 12.345 });
    const values = await readCollectionValues(state.db as never);
    expect(values.currency).toBe('EUR');
    expect(values.parts).toEqual({ amount: 12.35, currency: 'USD' });
    expect(values.items.get(sealed)).toEqual({ amount: 200, currency: 'EUR', source: 'bricklink', asOf: expect.any(String) });
    expect(new Date(values.items.get(sealed)?.asOf ?? '').getTime()).toBeLessThanOrEqual(prices.now().getTime());
    expect(values.items.get(boxed)).toMatchObject({ amount: 54, source: 'bricklink' });
    expect(values.items.get(figure)).toMatchObject({ amount: 16.2, source: 'bricklink' });
    expect(values.items.get(bulk)).toBeNull();
    expect(values.items.get(valuedBulk)).toEqual({ amount: 15, currency: 'EUR', source: 'override', asOf: null });
    expect(values.items.size).toBe(5);
  });

  it('[VAL-7] the override is the admin’s alone, validated, outside the item’s version, and blank takes it away', async () => {
    const id = await item({ setNum: '990001-1' });
    const { setValueOverride, readAdminValues } = service({});
    await expect(setValueOverride({} as AdminContext, { itemId: id, amount: 10 })).rejects.toThrow(NotAdminError);
    for (const amount of [-1, 10_000_001, 1.234, Number.NaN, Number.POSITIVE_INFINITY]) await expect(setValueOverride(admin, { itemId: id, amount })).rejects.toThrow();
    expect(await setValueOverride(admin, { itemId: id, amount: 249.9 })).toEqual({ status: 'saved', amount: 249.9, currency: 'EUR' });
    const [row] = await fresh.db.select().from(schema.collectionItem);
    expect(row).toMatchObject({ manualValueOverride: 249.9, manualValueCurrency: 'EUR', version: 1 });
    expect((await readAdminValues(admin)).values.items.get(id)).toEqual({ amount: 249.9, currency: 'EUR', source: 'override', asOf: null });
    expect(await setValueOverride(admin, { itemId: id, amount: null })).toMatchObject({ status: 'saved', amount: null });
    expect((await readAdminValues(admin)).values.items.get(id)).toBeNull();
    expect(await setValueOverride(admin, { itemId: randomUUID(), amount: 1 })).toMatchObject({ status: 'unknown-item' });
  });

  it('[VAL-5] the adjustments are whole percentages from -100 to 100, saved only by the admin', async () => {
    const { saveValueAdjustments, readValueAdjustments } = service({});
    await expect(saveValueAdjustments({} as AdminContext, { usedWithBoxPct: 0, usedNoBoxPct: 0 })).rejects.toThrow(NotAdminError);
    for (const bad of [101, -101, 2.5]) await expect(saveValueAdjustments(admin, { usedWithBoxPct: bad, usedNoBoxPct: 0 })).rejects.toThrow();
    expect(await readValueAdjustments(admin)).toEqual({ usedWithBoxPct: 0, usedNoBoxPct: 0 });
    expect(await saveValueAdjustments(admin, { usedWithBoxPct: -100, usedNoBoxPct: 100 })).toEqual({ usedWithBoxPct: -100, usedNoBoxPct: 100 });
    expect(await readValueAdjustments(admin)).toEqual({ usedWithBoxPct: -100, usedNoBoxPct: 100 });
  });

  it('[VAL-7] readAdminValues totals each segment', async () => {
    await item({ setNum: '990001-1', condition: 'SEALED' });
    await item({ setNum: '990001-1', condition: 'USED_NO_BOX' });
    await item({ kind: 'OTHER', condition: 'USED_NO_BOX' });
    const { refreshPrices, readAdminValues } = service({ 'SET 990001-1 N': { average: 100 }, 'SET 990001-1 U': { average: 40 } });
    await refreshPrices(admin, {});
    const { totals } = await readAdminValues(admin);
    expect(totals.sealed).toEqual({ amounts: [{ currency: 'EUR', amount: 100 }], valued: 1, unvalued: 0 });
    expect(totals.used).toEqual({ amounts: [{ currency: 'EUR', amount: 40 }], valued: 1, unvalued: 1 });
    expect(totals.parts).toEqual({ amounts: [], valued: 0, unvalued: 0 });
    expect(totals.all.amounts).toEqual([{ currency: 'EUR', amount: 140 }]);
    await expect(readAdminValues({} as AdminContext)).rejects.toThrow(NotAdminError);
  });
});
