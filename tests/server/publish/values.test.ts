import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { catalogueSettings } from '../../../src/db/schema/catalogue-settings';
import { NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { LOT_PAGE, readDownloadLots } from '../../../src/server/parts/lots';
import type { PublicCatalogueData } from '../../../src/server/publish/catalogue-data';
import { readPublication } from '../../../src/server/publish/projection';
import type { CollectionValues, ItemValue, PartsValue } from '../../../src/server/valuation/contract';
import { loadValuation } from '../../../src/server/valuation/values';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { anAdmin, publisher } from './fakes';

/**
 * Values and selling mode end to end (#211): the settings saved through their typed service
 * function (`src/server/settings/catalogue-values.ts`), and what the projection makes of them
 * ([PUB-17], [PUB-18], [PUB-20]). `[PUB-4]`'s matrix (`./no-private-field.test.ts`) holds every
 * combination; this holds the rules one at a time. Every value is made up.
 */

let fresh: FreshDatabase;
const state: { db?: FreshDatabase['db'] } = {};
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

beforeAll(async () => {
  fresh = await freshDatabase();
  state.db = fresh.db;
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('update collection_item set cover_photo_id = null; delete from photo; delete from collection_item; delete from lego_set; delete from parts_lot; delete from parts_import; delete from part_price_quote;');
  await fresh.db.update(catalogueSettings).set({
    publicToken: null,
    publishLease: null,
    publishLeaseUntil: null,
    showValues: false,
    sellingMode: false,
    sellingValueDisplay: null,
    askingPriceTotal: null,
    askingPriceSealed: null,
    askingPriceUsed: null,
    askingPriceParts: null,
  });
});

const NOW = new Date('2026-11-03T08:00:00.000Z');
const noPrices = { total: null, sealed: null, used: null, parts: null };

/** A made-up item that is not a set, so it needs no catalogue row. */
async function anItem(condition: 'SEALED' | 'USED_WITH_BOX' = 'SEALED', kind: 'OTHER' | 'MINIFIG' | 'BULK' = 'OTHER'): Promise<string> {
  const id = randomUUID();
  await fresh.db.insert(schema.collectionItem).values({
    id,
    kind,
    name: `Made-up item ${id.slice(0, 4)}`,
    condition,
    description: '',
    quantity: 1,
    storageLocation: 'made-up shelf',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function project(values: CollectionValues): Promise<PublicCatalogueData> {
  const { projection, release } = await readPublication(fresh.db, { now: () => NOW, readValues: async () => values });
  await release();
  return projection.catalogue;
}

const value = (amount: number, extra: Partial<ItemValue> = {}): ItemValue => ({ amount, currency: 'EUR', source: 'bricklink', asOf: '2026-10-30T21:15:00.000Z', ...extra });

/** A made-up parts value, all of it from BrickLink. */
const partsAt = (amount: number, currency = 'EUR'): PartsValue => ({ amount, currency, fromBrickLink: 1, fromFile: 0, none: 0 });

/** The values a reader answers: the items given, the parts given, and no lot of its own. */
const answer = (items: CollectionValues['items'], parts: PartsValue | null = null, currency = 'EUR'): CollectionValues => ({ items, parts, partsLots: new Map(), currency });

describe('the value settings', () => {
  it('[PUB-18] are saved through a typed admin operation, the display ASKING the first time selling mode is turned on', async () => {
    const { saveValueSettings, readValueSettings } = await import('../../../src/server/settings/catalogue-values');
    const forged = { sessionKey: 'made-up', requestId: 'made-up' } as unknown as AdminContext;
    await expect(saveValueSettings(forged, { showValues: true, sellingMode: false, askingPrices: noPrices })).rejects.toThrow(NotAdminError);
    await expect(readValueSettings(forged)).rejects.toThrow(NotAdminError);

    expect(await readValueSettings(anAdmin())).toEqual({ showValues: false, sellingMode: false, sellingValueDisplay: null, askingPrices: noPrices });
    // Show values alone sets no display.
    expect(await saveValueSettings(anAdmin(), { showValues: true, sellingMode: false, askingPrices: noPrices })).toMatchObject({ sellingValueDisplay: null });
    // Selling mode turned on, no display chosen: ASKING.
    expect(await saveValueSettings(anAdmin(), { showValues: true, sellingMode: true, askingPrices: { total: 1500, sealed: 999.99, used: null, parts: 0 } })).toEqual({
      showValues: true,
      sellingMode: true,
      sellingValueDisplay: 'ASKING',
      askingPrices: { total: 1500, sealed: 999.99, used: null, parts: 0 },
    });
    // A display chosen is kept, also when selling mode is turned off and on again.
    await saveValueSettings(anAdmin(), { showValues: false, sellingMode: true, sellingValueDisplay: 'BOTH', askingPrices: noPrices });
    await saveValueSettings(anAdmin(), { showValues: false, sellingMode: false, askingPrices: noPrices });
    expect(await saveValueSettings(anAdmin(), { showValues: false, sellingMode: true, askingPrices: noPrices })).toMatchObject({ sellingValueDisplay: 'BOTH' });
  });

  it('[PUB-18] refuse an asking price that is negative, too large, finer than a cent, or a display that is not one of the three', async () => {
    const { saveValueSettings } = await import('../../../src/server/settings/catalogue-values');
    const save = (askingPrices: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      saveValueSettings(anAdmin(), { showValues: false, sellingMode: true, askingPrices: { ...noPrices, ...askingPrices }, ...extra } as never);
    for (const total of [-1, 1_000_000_001, 1.005, Number.NaN, '12']) await expect(save({ total }), String(total)).rejects.toThrow();
    await expect(save({}, { sellingValueDisplay: 'canary' })).rejects.toThrow();
    await expect(save({}, { extra: true })).rejects.toThrow(/unrecognized/i);
  });
});

describe('the projection', () => {
  it('[PUB-17] reads no value while the settings show none, and publishes none', async () => {
    const id = await anItem();
    const readValues = vi.fn(async (): Promise<CollectionValues> => answer(new Map([[id, value(10)]])));
    const { projection, release } = await readPublication(fresh.db, { now: () => NOW, readValues });
    await release();
    expect(readValues).not.toHaveBeenCalled();
    expect(projection.catalogue.items[0]).not.toHaveProperty('value');
    expect(projection.catalogue).not.toHaveProperty('totals');
  });

  it('[PUB-17] publishes a value only in the deployment’s currency, dated by its quote’s day, an override by the publish’s', async () => {
    await fresh.db.update(catalogueSettings).set({ showValues: true });
    const quoted = await anItem();
    const overridden = await anItem('USED_WITH_BOX');
    const foreign = await anItem('USED_WITH_BOX');
    const none = await anItem();
    const data = await project(
      answer(
        new Map([
          [quoted, value(100.004)],
          [overridden, value(50, { source: 'override', asOf: null })],
          [foreign, value(70, { currency: 'USD' })],
          [none, null],
        ]),
        partsAt(5, 'USD'),
      ),
    );
    const byId = new Map(data.items.map((one) => [one.id, one]));
    expect(byId.get(quoted)).toMatchObject({ value: 100, asOf: '2026-10-30' });
    expect(byId.get(overridden)).toMatchObject({ value: 50, asOf: '2026-11-03' });
    expect(byId.get(foreign)).not.toHaveProperty('value');
    expect(byId.get(none)).not.toHaveProperty('asOf');
    // The totals are of what is published: never the foreign value, never the foreign parts value.
    expect(data.totals).toEqual({ all: 150, sealed: 100, used: 50 });
    expect(data.valueCurrency).toBe('EUR');
    // The quote's instant is never published, only its day.
    expect(JSON.stringify(data)).not.toContain('21:15');
  });

  it('[PUB-17] [PUB-19] count a minifigure as used and a bulk lot with the loose parts, as segmentOf does', async () => {
    await fresh.db.update(catalogueSettings).set({ sellingMode: true, sellingValueDisplay: 'MARKET' });
    const minifig = await anItem('SEALED', 'MINIFIG');
    const bulk = await anItem('USED_WITH_BOX', 'BULK');
    const data = await project(answer(new Map([[minifig, value(8)], [bulk, value(30, { source: 'override', asOf: null })]])));
    expect(data.totals).toEqual({ all: 38, used: 8, parts: 30 });
    expect(data.segments).toEqual(['used', 'parts']);
    expect(data.items.map((one) => one.segment).sort()).toEqual(['parts', 'used']);
  });

  it('[PUB-18] never publishes an asking price stored while selling mode is off, nor one with the display MARKET', async () => {
    await fresh.db.update(catalogueSettings).set({ askingPriceTotal: 1234.5, askingPriceSealed: 1000, sellingValueDisplay: 'BOTH', showValues: true });
    const values: CollectionValues = answer(new Map());
    expect(await project(values)).not.toHaveProperty('asking');
    await fresh.db.update(catalogueSettings).set({ sellingMode: true, sellingValueDisplay: 'MARKET' });
    expect(await project(values)).not.toHaveProperty('asking');
    await fresh.db.update(catalogueSettings).set({ sellingValueDisplay: 'ASKING' });
    expect(await project(values)).toMatchObject({ asking: { total: 1234.5, sealed: 1000 }, valueCurrency: 'EUR' });
    // With ASKING alone, no market value anywhere, Show values notwithstanding.
    const id = await anItem();
    const data = await project(answer(new Map([[id, value(10)]]), partsAt(3)));
    expect(data.items[0]).not.toHaveProperty('value');
    expect(data).not.toHaveProperty('totals');
    expect(data.parts).toBeNull();
  });

  it('[PUB-17] refuses to publish under a deployment currency that is not a three-letter code', async () => {
    await fresh.db.update(catalogueSettings).set({ showValues: true });
    await expect(readPublication(fresh.db, { now: () => NOW, readValues: async () => answer(new Map(), null, '<b>') })).rejects.toThrow(/ISO 4217/);
  });
});

describe('the parts download', () => {
  async function anImport(lots: number, currency: string | null) {
    const importId = randomUUID();
    await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BL_XML', currency, importedAt: NOW, lots, quantity: lots * 2, totalValue: null });
    const rows = Array.from({ length: lots }, (_, index) => ({
      importId,
      itemType: 'P',
      itemNo: String(3000 + index),
      colorId: index % 7,
      lotCondition: index % 2 === 0 ? ('N' as const) : ('U' as const),
      lotQuantity: 2,
      unitPrice: 0.125,
    }));
    for (let at = 0; at < rows.length; at += 500) await fresh.db.insert(schema.partsLot).values(rows.slice(at, at + 500));
  }

  it('[PUB-20] reads every lot in pages, in a fixed order, with its id and never a price or the file’s currency', async () => {
    await anImport(LOT_PAGE + 3, 'EUR');
    const lots = await readDownloadLots(fresh.db);
    expect(lots?.lots).toHaveLength(LOT_PAGE + 3);
    expect(lots).not.toHaveProperty('currency');
    expect(lots?.lots.every((lot) => !('unitPrice' in lot))).toBe(true);
    expect(lots?.lots.slice(0, 2).map((lot) => lot.itemNo)).toEqual(['3000', '3001']);
    expect(lots?.lots[0]).toEqual({ id: expect.any(String), itemType: 'P', itemNo: '3000', colorId: 0, condition: 'N', quantity: 2 });
  });

  /** The real values reader, in EUR. */
  const readValues = async (db: Parameters<typeof loadValuation>[0]) => (await loadValuation(db, 'EUR')).values;

  it('[PUB-20] [VAL-6] is published in selling mode alone, each lot’s price its value by [VAL-6] over its quantity, only with market values', async () => {
    await anImport(2, 'USD');
    const { publish, store } = publisher(fresh.db, { readValues });
    const files = async () => {
      expect(await publish(anAdmin(), {})).toMatchObject({ status: 'published' });
      return [...store.objects.keys()].map((key) => key.split('/').slice(2).join('/'));
    };
    expect(await files()).not.toContain('parts.csv');
    await fresh.db.update(catalogueSettings).set({ sellingMode: true, sellingValueDisplay: 'BOTH' });
    expect(await files()).toEqual(expect.arrayContaining(['parts.csv', 'parts.xml', 'parts/']));
    const csv = () => Buffer.from([...store.objects].find(([key]) => key.endsWith('parts.csv'))?.[1].body ?? []).toString();
    const catalogue = () => JSON.parse(Buffer.from([...store.objects].find(([key]) => key.endsWith('catalogue.json'))?.[1].body ?? []).toString()) as PublicCatalogueData;
    // The file's prices are in USD, the catalogue's currency EUR, and no BrickLink price: no price, no parts value.
    expect(csv()).not.toContain('0.125');
    expect(catalogue().parts).not.toHaveProperty('value');
    await fresh.db.update(schema.partsImport).set({ currency: null });
    await files();
    // A file naming no currency is taken to be in the deployment's: 0.125 × 2 = 0.25, rounded once to the cent, over 2.
    expect(csv()).toContain('Unit price (EUR)');
    expect(csv()).toContain('P,3000,0,N,2,0.125\r\n');
    expect(catalogue().parts?.value).toBe(0.5);
    // BrickLink first: lot 3001 (colour 1, used) has a quote, which counts over the file's price.
    await fresh.db.insert(schema.partPriceQuote).values({ itemType: 'PART', itemNo: '3001', colorId: 1, newOrUsed: 'U', average: 1.333, sampleSize: 4, currency: 'EUR', source: 'bricklink', fetchedAt: NOW, attemptedAt: NOW });
    await files();
    // 1.333 × 2 = 2.666, so the lot's value is 2.67 and its unit price 1.335.
    expect(csv()).toContain('P,3001,1,U,2,1.335\r\n');
    expect(catalogue().parts?.value).toBe(2.92);
    // A quote in another currency doesn't count: the file's price does.
    await fresh.db.update(schema.partPriceQuote).set({ currency: 'USD' });
    await files();
    expect(csv()).toContain('P,3001,1,U,2,0.125\r\n');
    await fresh.db.update(catalogueSettings).set({ sellingValueDisplay: 'ASKING' });
    await files();
    expect(csv()).not.toContain('0.125');
    expect(catalogue().parts).not.toHaveProperty('value');
    await fresh.db.update(catalogueSettings).set({ sellingMode: false });
    expect(await files()).not.toContain('parts.csv');
  });

  it('[PUB-20] gives a lot with no value no price, and never a lot’s id', async () => {
    await anImport(1, 'USD');
    await fresh.db.update(catalogueSettings).set({ sellingMode: true, sellingValueDisplay: 'MARKET' });
    const [lot] = await fresh.db.select().from(schema.partsLot);
    const data = await project(answer(new Map(), null));
    expect(data.parts?.list).toEqual([{ type: 'P', no: '3000', color: 0, condition: 'N', quantity: 2 }]);
    const valued = await project({ ...answer(new Map(), partsAt(9.99)), partsLots: new Map([[lot?.id ?? '', 9.99]]) });
    expect(valued.parts?.list).toEqual([{ type: 'P', no: '3000', color: 0, condition: 'N', quantity: 2, price: 4.995 }]);
    expect(valued.parts?.value).toBe(9.99);
    expect(JSON.stringify(valued)).not.toContain(lot?.id ?? 'no lot');
  });
});
