import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createValuationService } from '../../../src/server/valuation/refresh';
import { readCollectionValues } from '../../../src/server/valuation/values';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';

/**
 * `setValueOverride`, `saveValueAdjustments` and `readCollectionValues` over the test database
 * (brief #207, Issue B, [VAL-5] to [VAL-7]), with quotes stored as the background job stores them
 * (`./job.test.ts` holds the job). Every set, minifigure, price and item here is made up.
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

function service(options: { currency?: string } = {}) {
  return createValuationService({ log: capture.log, currency: () => options.currency ?? 'EUR' });
}

/** Stores BrickLink's answer for a quote, as the job does. */
async function quote(itemType: 'SET' | 'MINIFIG', itemNo: string, newOrUsed: 'N' | 'U', average: number): Promise<void> {
  await fresh.db.insert(schema.priceQuote).values({ itemType, itemNo, newOrUsed, average, sampleSize: 5, currency: 'EUR', source: 'bricklink', fetchedAt: AT, attemptedAt: AT });
}

describe('the values', () => {
  it('[VAL-5] [VAL-6] [VAL-7] readCollectionValues answers each item’s value with its source and date, the parts’ value and the currency', async () => {
    const sealed = await item({ setNum: '990001-1', condition: 'SEALED', quantity: 2 });
    const boxed = await item({ setNum: '990001-1', condition: 'USED_WITH_BOX' });
    const figure = await item({ kind: 'MINIFIG', refNo: 'mu0001', condition: 'USED_NO_BOX', quantity: 3 });
    const bulk = await item({ kind: 'BULK', condition: 'USED_NO_BOX' });
    const valuedBulk = await item({ kind: 'BULK', condition: 'USED_NO_BOX', manualValueOverride: 15, manualValueCurrency: 'EUR' });
    const { saveValueAdjustments } = service();
    await quote('SET', '990001-1', 'N', 100);
    await quote('SET', '990001-1', 'U', 60);
    await quote('MINIFIG', 'mu0001', 'U', 4.5);
    await saveValueAdjustments(admin, { usedWithBoxPct: -10, usedNoBoxPct: 20 });
    const importId = randomUUID();
    await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BSX', currency: 'USD', importedAt: AT, lots: 2, quantity: 30, totalValue: 12.345 });
    const values = await readCollectionValues(state.db as never);
    expect(values.currency).toBe('EUR');
    expect(values.parts).toEqual({ amount: 12.35, currency: 'USD' });
    expect(values.items.get(sealed)).toEqual({ amount: 200, currency: 'EUR', source: 'bricklink', asOf: expect.any(String) });
    expect(new Date(values.items.get(sealed)?.asOf ?? '').getTime()).toBe(AT.getTime());
    expect(values.items.get(boxed)).toMatchObject({ amount: 54, source: 'bricklink' });
    expect(values.items.get(figure)).toMatchObject({ amount: 16.2, source: 'bricklink' });
    expect(values.items.get(bulk)).toBeNull();
    expect(values.items.get(valuedBulk)).toEqual({ amount: 15, currency: 'EUR', source: 'override', asOf: null });
    expect(values.items.size).toBe(5);
  });

  it('[VAL-7] the override is the admin’s alone, validated, outside the item’s version, and blank takes it away', async () => {
    const id = await item({ setNum: '990001-1' });
    const { setValueOverride, readAdminValues } = service();
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
    const { saveValueAdjustments, readValueAdjustments } = service();
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
    const { readAdminValues } = service();
    await quote('SET', '990001-1', 'N', 100);
    await quote('SET', '990001-1', 'U', 40);
    const { totals } = await readAdminValues(admin);
    expect(totals.sealed).toEqual({ amounts: [{ currency: 'EUR', amount: 100 }], valued: 1, unvalued: 0 });
    expect(totals.used).toEqual({ amounts: [{ currency: 'EUR', amount: 40 }], valued: 1, unvalued: 1 });
    expect(totals.parts).toEqual({ amounts: [], valued: 0, unvalued: 0 });
    expect(totals.all.amounts).toEqual([{ currency: 'EUR', amount: 140 }]);
    await expect(readAdminValues({} as AdminContext)).rejects.toThrow(NotAdminError);
  });
});
