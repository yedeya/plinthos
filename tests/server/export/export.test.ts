import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { catalogueSettings } from '../../../src/db/schema/catalogue-settings';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createExport } from '../../../src/server/export/export';
import { summaryFigures } from '../../../src/server/export/summary';
import { assertPublicProjection, NotAPublicProjectionError, readCatalogueData } from '../../../src/server/publish/projection';
import type { CollectionValues, ItemValue } from '../../../src/server/valuation/contract';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';

/**
 * The export (#236): `exportCollection`'s two presets ([EXP-1] to [EXP-3]) and the summary's
 * data ([EXP-5]) over a made-up collection. `[PUB-4]`'s matrix (`../publish/no-private-field.test.ts`)
 * holds the buyer preset and the summary to no private field under every combination of the
 * settings; this holds the presets' columns and rows one rule at a time. Every value is made up.
 */

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});

const NOW = new Date('2026-11-03T08:00:00.000Z');
const CREATED = new Date('2026-10-01T10:00:00.000Z');
const UPDATED = new Date('2026-10-02T11:30:00.000Z');
const SET_ID = '6f1c3c1e-8a4b-4c55-9d0e-0a1b2c3d4e5f';
const BULK_ID = '7a2d4d2f-9b5c-4d66-8e1f-1b2c3d4e5f60';

const admin = (): AdminContext => issueAdminContext({ sessionKey: '00000000-0000-4000-8000-000000000001', requestId: 'request-made-up-export' });

beforeEach(async () => {
  await fresh.client.query('update collection_item set cover_photo_id = null; delete from photo; delete from collection_item; delete from lego_set; delete from parts_lot; delete from parts_import;');
  await fresh.db.update(catalogueSettings).set({
    publicToken: null,
    showValues: false,
    sellingMode: false,
    sellingValueDisplay: null,
    introText: 'A made-up collection.',
    contactText: 'Write to the made-up owner.',
    askingPriceTotal: 9876.5,
    askingPriceSealed: 4321.75,
    askingPriceUsed: null,
    askingPriceParts: 6543.25,
  });
  await fresh.db.insert(schema.legoSet).values({ setNum: '99999-1', name: 'Made-up Station', theme: 'Made-up Theme', year: 2001, numParts: 1234, fetchedAt: NOW });
  await fresh.db.insert(schema.collectionItem).values([
    {
      id: SET_ID,
      kind: 'SET',
      setNum: '99999-1',
      condition: 'SEALED',
      complete: true,
      hasInstructions: true,
      description: '=HYPERLINK("https://example.test")',
      quantity: 2,
      storageLocation: 'made-up attic, box 3',
      manualValueOverride: null,
      version: 1,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
    {
      id: BULK_ID,
      kind: 'BULK',
      name: 'Made-up bucket, mixed',
      approxParts: 800,
      approxWeightG: 1500,
      condition: 'USED_NO_BOX',
      complete: false,
      missingNotes: '-a few tiles',
      description: 'Loose, sorted by colour',
      quantity: 1,
      storageLocation: 'made-up cellar',
      manualValueOverride: 45.5,
      manualValueCurrency: 'EUR',
      version: 1,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
  ]);
  const importId = randomUUID();
  await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BSX', currency: 'EUR', importedAt: NOW, lots: 1, quantity: 30, totalValue: 3 });
  await fresh.db.insert(schema.partsLot).values({ importId, itemType: 'P', itemNo: '3001', colorId: 5, lotCondition: 'U', lotQuantity: 30, unitPrice: 0.1 });
});

const values = (): CollectionValues => ({
  items: new Map<string, ItemValue | null>([
    [SET_ID, { amount: 250.25, currency: 'EUR', source: 'bricklink', asOf: '2026-10-30T21:15:00.000Z' }],
    [BULK_ID, { amount: 45.5, currency: 'EUR', source: 'override', asOf: null }],
  ]),
  parts: { amount: 3, currency: 'EUR', fromBrickLink: 0, fromFile: 1, none: 0 },
  partsLots: new Map(),
  currency: 'EUR',
});

function exporter() {
  const capture = captureLogger();
  const service = createExport({ database: () => fresh.db, now: () => NOW, readValues: async () => values(), log: capture.log });
  return { ...service, capture };
}

/** A CSV file as rows of cells, by RFC 4180, after its byte-order mark. */
function parseCsv(csv: string): string[][] {
  expect(csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const text = csv.slice(1);
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index++;
    } else cell += char;
  }
  expect(cell).toBe('');
  return rows;
}

/** The rows as objects by the header's names. */
function records(csv: string): { header: string[]; rows: Record<string, string>[] } {
  const [header = [], ...rows] = parseCsv(csv);
  return { header, rows: rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? '']))) };
}

const PUBLIC_HEADER = ['Kind', 'Set number', 'Name', 'Reference number', 'Theme', 'Year', 'Parts', 'Approx. parts', 'Approx. weight (g)', 'Condition', 'Complete', 'Missing parts', 'Instructions', 'Description', 'Quantity'];

describe('the buyer preset', () => {
  it('[EXP-2] holds one row per published item with its public fields, and no value column while values are hidden', async () => {
    const { exportCollection, capture } = exporter();
    const file = await exportCollection(admin(), { preset: 'buyer' });
    expect(file.fileName).toBe('plinthos-buyer-2026-11-03.csv');
    expect(file.rows).toBe(2);
    const { header, rows } = records(file.csv);
    expect(header).toEqual(PUBLIC_HEADER);
    expect(rows).toEqual([
      { Kind: 'Set', 'Set number': '99999-1', Name: 'Made-up Station', 'Reference number': '', Theme: 'Made-up Theme', Year: '2001', Parts: '1234', 'Approx. parts': '', 'Approx. weight (g)': '', Condition: 'Sealed', Complete: 'yes', 'Missing parts': '', Instructions: 'yes', Description: `'=HYPERLINK("https://example.test")`, Quantity: '2' },
      { Kind: 'Bulk lot', 'Set number': '', Name: 'Made-up bucket, mixed', 'Reference number': '', Theme: '', Year: '', Parts: '', 'Approx. parts': '800', 'Approx. weight (g)': '1500', Condition: 'Used, no box', Complete: 'no', 'Missing parts': "'-a few tiles", Instructions: '', Description: 'Loose, sorted by colour', Quantity: '1' },
    ]);
    for (const hidden of ['made-up attic', 'made-up cellar', SET_ID, BULK_ID, '250.25', '45.5', '9876', '4321', '6543', '3001']) expect(file.csv, hidden).not.toContain(hidden);
    // [EXP-1] The download is logged with its preset and its row count, never its content.
    const events = capture.events().filter((event) => event.businessEvent === 'export.downloaded');
    expect(events).toEqual([expect.objectContaining({ businessEvent: 'export.downloaded', preset: 'buyer', rows: 2 })]);
    for (const line of capture.lines) for (const content of ['Made-up Station', 'HYPERLINK', 'made-up attic', 'Made-up bucket']) expect(line).not.toContain(content);
  });

  it('[EXP-2] adds the value, as-of and currency columns exactly when the catalogue shows market values, and never an asking price', async () => {
    for (const [settings, market] of [
      [{ showValues: true, sellingMode: false, sellingValueDisplay: null }, true],
      [{ showValues: true, sellingMode: true, sellingValueDisplay: 'ASKING' as const }, false],
      [{ showValues: false, sellingMode: true, sellingValueDisplay: 'MARKET' as const }, true],
      [{ showValues: false, sellingMode: true, sellingValueDisplay: 'BOTH' as const }, true],
    ] as const) {
      await fresh.db.update(catalogueSettings).set(settings);
      const file = await exporter().exportCollection(admin(), { preset: 'buyer' });
      const { header, rows } = records(file.csv);
      const label = JSON.stringify(settings);
      expect(header, label).toEqual([...PUBLIC_HEADER, ...(market ? ['Value', 'Value as of', 'Currency'] : [])]);
      expect(header.some((name) => /ask/i.test(name)), label).toBe(false);
      for (const asking of ['9876', '4321', '6543']) expect(file.csv, label).not.toContain(asking);
      if (market) {
        expect(rows.map((row) => [row.Value, row['Value as of'], row.Currency]), label).toEqual([
          ['250.25', '2026-10-30', 'EUR'],
          ['45.5', '2026-11-03', 'EUR'],
        ]);
      }
    }
  });

  it('[EXP-1] [EXP-2] refuses anything but the admin, and any preset but the two', async () => {
    const { exportCollection } = exporter();
    await expect(exportCollection({ sessionKey: 'x', requestId: 'y' } as unknown as AdminContext, { preset: 'buyer' })).rejects.toThrow(NotAdminError);
    await expect(exportCollection(admin(), { preset: 'everything' as 'full' })).rejects.toThrow();
    await expect(exportCollection(admin(), { preset: 'buyer', extra: true } as unknown as { preset: 'buyer' })).rejects.toThrow();
  });
});

describe('the full preset', () => {
  it('[EXP-3] holds every item with every field entered, the private ones, its value with source and date, and its times, and no parts lot', async () => {
    const { exportCollection, capture } = exporter();
    const file = await exportCollection(admin(), { preset: 'full' });
    expect(file.fileName).toBe('plinthos-full-2026-11-03.csv');
    expect(file.rows).toBe(2);
    const { header, rows } = records(file.csv);
    expect(header).toEqual([...PUBLIC_HEADER, 'Storage location', 'Value override', 'Override currency', 'Value', 'Value currency', 'Value source', 'Value as of', 'Created', 'Updated', 'Id']);
    expect(rows[0]).toMatchObject({ Name: 'Made-up Station', 'Storage location': 'made-up attic, box 3', 'Value override': '', 'Override currency': '', Value: '250.25', 'Value currency': 'EUR', 'Value source': 'bricklink', 'Value as of': '2026-10-30', Created: CREATED.toISOString(), Updated: UPDATED.toISOString(), Id: SET_ID });
    expect(rows[1]).toMatchObject({ Name: 'Made-up bucket, mixed', 'Storage location': 'made-up cellar', 'Value override': '45.5', 'Override currency': 'EUR', Value: '45.5', 'Value source': 'override', 'Value as of': '', Id: BULK_ID });
    // No loose parts lot is a row: the parts list is [PUB-20]'s download.
    expect(file.csv).not.toContain('3001');
    expect(capture.events().filter((event) => event.businessEvent === 'export.downloaded')).toEqual([expect.objectContaining({ preset: 'full', rows: 2 })]);
    for (const line of capture.lines) expect(line).not.toContain('made-up attic');
  });
});

describe('the summary’s data', () => {
  it('[EXP-5] is the catalogue as a publish would make it now, read without the publish’s turn or token, and never a projection the writer takes', async () => {
    await fresh.db.update(catalogueSettings).set({ sellingMode: true, sellingValueDisplay: 'BOTH' });
    const data = await exporter().readCatalogueSummary(admin(), {});
    expect(data.publishedAt).toBe(NOW.toISOString());
    expect(data.introText).toBe('A made-up collection.');
    const [settings] = await fresh.db.select().from(catalogueSettings);
    // No token was made, and no turn taken.
    expect(settings?.publicToken).toBeNull();
    expect(settings?.publishLease).toBeNull();
    expect(() => assertPublicProjection(data)).toThrow(NotAPublicProjectionError);
    expect(() => assertPublicProjection({ catalogue: data, photoCopies: [] })).toThrow(NotAPublicProjectionError);
    expect(Object.keys(data)).not.toContain('photoCopies');
    expect(summaryFigures(data)).toEqual({
      segments: [
        { segment: 'sealed', items: 1, units: 2, value: 250.25, asking: 4321.75 },
        { segment: 'parts', items: 1, units: 1, value: 48.5, asking: 6543.25 },
      ],
      parts: { lots: 1, quantity: 30, value: 3 },
      total: 298.75,
      askingTotal: 9876.5,
      currency: 'EUR',
    });
    // The same data the projection's reader answers.
    expect(await readCatalogueData(fresh.db, { now: () => NOW, readValues: async () => values() })).toEqual(
      expect.objectContaining({ items: expect.any(Array), asking: { total: 9876.5, sealed: 4321.75, parts: 6543.25 } }),
    );
  });

  it('[EXP-5] refuses anything but the admin', async () => {
    await expect(exporter().readCatalogueSummary({} as AdminContext, {})).rejects.toThrow(NotAdminError);
  });
});

