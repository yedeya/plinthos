import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createValuationService } from '../../../src/server/valuation/refresh';
import { LOT_PAGE } from '../../../src/server/parts/lots';
import { PARTS_PAGE_SIZE, readCollectionValues } from '../../../src/server/valuation/values';
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
  await fresh.client.query('truncate price_quote, part_price_quote, photo, collection_item, lego_set, parts_lot, parts_import cascade');
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

interface LotFields {
  readonly itemType?: string;
  readonly itemNo: string;
  readonly colorId?: number;
  readonly lotCondition?: 'N' | 'U';
  readonly lotQuantity?: number;
  readonly unitPrice?: number | null;
}

/** Stores a parts import and its lots, as `importPartsFile` would have; answers its id. */
async function anImport(currency: string | null, lots: readonly LotFields[]): Promise<string> {
  const importId = randomUUID();
  await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BSX', currency, importedAt: AT, lots: lots.length, quantity: lots.length, totalValue: null });
  const rows = lots.map((lot) => ({ importId, itemType: 'P', colorId: 0, lotCondition: 'N' as const, lotQuantity: 1, unitPrice: null, ...lot }));
  for (let at = 0; at < rows.length; at += 500) await fresh.db.insert(schema.partsLot).values(rows.slice(at, at + 500));
  return importId;
}

/** Stores BrickLink's answer for a part's quote, as the job does. */
async function partQuote(itemNo: string, colorId: number, newOrUsed: 'N' | 'U', average: number | null, currency = 'EUR'): Promise<void> {
  await fresh.db
    .insert(schema.partPriceQuote)
    .values({ itemType: 'PART', itemNo, colorId, newOrUsed, average, sampleSize: average === null ? 0 : 5, currency, source: 'bricklink', fetchedAt: average === null ? null : AT, attemptedAt: AT });
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
    const importId = await anImport('EUR', [
      { itemNo: '3001', unitPrice: 0.5, lotQuantity: 10 },
      { itemNo: '3002', unitPrice: 0.125, lotQuantity: 3 },
    ]);
    await partQuote('3001', 0, 'N', 0.25);
    const values = await readCollectionValues(state.db as never);
    expect(values.currency).toBe('EUR');
    // [VAL-6] 3001 from BrickLink, 0.25 × 10; 3002 from the file, 0.125 × 3 = 0.375, to the cent 0.38.
    expect(values.parts).toEqual({ amount: 2.88, currency: 'EUR', fromBrickLink: 1, fromFile: 1, none: 0 });
    const lots = await fresh.db.select().from(schema.partsLot).where(eq(schema.partsLot.importId, importId));
    expect(new Map([...values.partsLots].map(([id, amount]) => [lots.find((lot) => lot.id === id)?.itemNo, amount]))).toEqual(new Map([['3001', 2.5], ['3002', 0.38]]));
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

describe('the loose parts’ value', () => {
  it('[VAL-6] values every lot BrickLink first, then the file’s price, else none, with more lots and more quotes than one page reads', async () => {
    // More lots and more stored quotes than LOT_PAGE, so both reads need a second page.
    const count = LOT_PAGE + 500;
    const lots = Array.from({ length: count }, (_, index) => ({ itemNo: `9${String(index).padStart(5, '0')}`, colorId: index % 3, lotCondition: index % 2 === 0 ? ('N' as const) : ('U' as const), lotQuantity: 2, unitPrice: index % 4 === 0 ? null : 0.1 }));
    const importId = await anImport(null, lots);
    // Every lot but one in seven has a quote; the first quote has no average, so its lot falls back.
    const quoted = lots.filter((_, index) => index % 7 !== 6);
    const rows = quoted.map((lot, index) => ({ itemType: 'PART' as const, itemNo: lot.itemNo, colorId: lot.colorId, newOrUsed: lot.lotCondition, average: index === 0 ? null : 0.5, sampleSize: 3, currency: 'EUR', source: 'bricklink' as const, fetchedAt: index === 0 ? null : AT, attemptedAt: AT }));
    expect(rows.length).toBeGreaterThan(LOT_PAGE);
    for (let at = 0; at < rows.length; at += 500) await fresh.db.insert(schema.partPriceQuote).values(rows.slice(at, at + 500));

    // Every read of the lots and the quotes is a page of at most LOT_PAGE rows.
    const query = vi.spyOn(pool, 'query');
    const { values } = await service().readAdminValues(admin);
    const reads = query.mock.calls.map(([sent]) => (typeof sent === 'string' ? sent : (sent as { text: string }).text)).filter((text) => /from "(parts_lot|part_price_quote)"/.test(text) && text.startsWith('select'));
    query.mockRestore();
    expect(reads.filter((text) => text.includes('from "parts_lot"'))).toHaveLength(2);
    expect(reads.filter((text) => text.includes('from "part_price_quote"'))).toHaveLength(2);
    for (const text of reads) expect(text).toMatch(/order by .* limit \$\d+( offset \$\d+)?$/);

    // Every lot whose quote the second page holds is still valued from BrickLink: 0.5 × 2.
    const later = await fresh.client.query<{ item_no: string }>(`select item_no from part_price_quote order by id asc offset ${LOT_PAGE}`);
    expect(later.rows.length).toBeGreaterThan(0);
    const stored = await fresh.db.select({ id: schema.partsLot.id, itemNo: schema.partsLot.itemNo }).from(schema.partsLot).where(eq(schema.partsLot.importId, importId));
    const idOf = new Map(stored.map((lot) => [lot.itemNo, lot.id]));
    const firstNo = quoted[0]?.itemNo;
    for (const { item_no } of later.rows) {
      if (item_no !== firstNo) expect(values.partsLots.get(idOf.get(item_no) ?? ''), item_no).toBe(1);
    }

    const expected = { bricklink: 0, file: 0, none: 0, cents: 0 };
    lots.forEach((lot, index) => {
      if (index % 7 !== 6 && index !== 0) {
        expected.bricklink += 1;
        expected.cents += 100;
      } else if (lot.unitPrice !== null) {
        expected.file += 1;
        expected.cents += 20;
      } else expected.none += 1;
    });
    expect(values.parts).toEqual({ amount: expected.cents / 100, currency: 'EUR', fromBrickLink: expected.bricklink, fromFile: expected.file, none: expected.none });
    expect(values.partsLots.size).toBe(count);
  });

  it('[VAL-6] values no file price in another currency, and counts only the parts with a value in the parts total', async () => {
    await anImport('USD', [{ itemNo: '3001', unitPrice: 2 }, { itemNo: '3002', unitPrice: 3 }]);
    const { values, totals } = await service().readAdminValues(admin);
    expect(values.parts).toEqual({ amount: null, currency: 'EUR', fromBrickLink: 0, fromFile: 0, none: 2 });
    expect(totals.parts.amounts).toEqual([]);
    await partQuote('3002', 0, 'N', 1.5);
    const after = await service().readAdminValues(admin);
    expect(after.values.parts).toMatchObject({ amount: 1.5, fromBrickLink: 1, none: 1 });
    expect(after.totals.parts.amounts).toEqual([{ currency: 'EUR', amount: 1.5 }]);
    // A quote in another currency than the deployment's values nothing.
    expect((await service({ currency: 'CHF' }).readAdminValues(admin)).values.parts).toMatchObject({ amount: null, currency: 'CHF', none: 2 });
  });

  it('[VAL-11] readPartsValues answers the value by source and the lots 100 to a page, each with its unit price, value, source and date', async () => {
    const lots = Array.from({ length: PARTS_PAGE_SIZE * 2 + 1 }, (_, index) => ({ itemNo: `8${String(index).padStart(4, '0')}`, unitPrice: index === 0 ? null : 0.2, lotQuantity: 5 }));
    await anImport('EUR', lots);
    await partQuote('80001', 0, 'N', 1.111);
    const { readPartsValues } = service();
    const first = await readPartsValues(admin, { page: 1 });
    expect(first).toMatchObject({ page: 1, pages: 3, count: PARTS_PAGE_SIZE * 2 + 1, fileCurrency: 'EUR' });
    expect(first?.value).toEqual({ amount: 5.56 + 199 * 1, currency: 'EUR', fromBrickLink: 1, fromFile: 199, none: 1 });
    expect(first?.lots).toHaveLength(PARTS_PAGE_SIZE);
    expect(first?.lots[0]).toMatchObject({ itemType: 'P', itemNo: '80000', colorId: 0, lotCondition: 'N', lotQuantity: 5, unitPrice: null, value: null });
    expect(first?.lots[1]).toMatchObject({ itemNo: '80001', value: { amount: 5.56, unitPrice: 1.111, source: 'bricklink', asOf: AT.toISOString() } });
    expect(first?.lots[2]).toMatchObject({ itemNo: '80002', value: { amount: 1, unitPrice: 0.2, source: 'file', asOf: null } });
    const last = await readPartsValues(admin, { page: 3 });
    expect(last?.lots.map((lot) => lot.itemNo)).toEqual(['80200']);
    // A page past the last shows the last.
    expect((await readPartsValues(admin, { page: 99 }))?.page).toBe(3);
    // The page is validated, and the reader is the admin's alone.
    for (const page of [0, -1, 1.5, Number.NaN, 10_001]) await expect(readPartsValues(admin, { page })).rejects.toThrow();
    await expect(readPartsValues({} as AdminContext, { page: 1 })).rejects.toThrow(NotAdminError);
  });

  it('[VAL-11] readPartsValues answers null when nothing is imported', async () => {
    expect(await service().readPartsValues(admin, { page: 1 })).toBeNull();
  });
});
