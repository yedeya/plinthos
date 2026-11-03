/**
 * The collection's export (brief #233, Issue A, #236): `exportCollection`, the two CSV presets the
 * owner downloads from `/admin` ([EXP-1] to [EXP-4]), and `readCatalogueSummary`, the data of the
 * printable summary ([EXP-5]). Both are typed service functions only the signed-in admin can call
 * (`AGENTS.md` §4).
 *
 * - **For a buyer** ([EXP-2]): built from `readCatalogueData` (`../publish/projection.ts`), the
 *   one function that builds the publish step's catalogue, with the settings as they are now. It
 *   never reads the database itself, so it holds what the catalogue would publish and nothing
 *   more: one row per published item, its public fields, and the value, as-of and currency columns
 *   only when an item carries a market value, which the projection gives only when the settings
 *   show them ([PUB-17], [PUB-18]). Never an asking price: that belongs to a segment or the whole
 *   collection, and the summary shows it.
 * - **Full** ([EXP-3]): the owner's own record, read straight from the database: every item with
 *   every field entered, the storage location and the override with its currency included, the
 *   item's value by `[VAL-5]` with its source and date (`readCollectionValues`), and when it was
 *   created and last changed. It is a new reader of private columns, which only this download
 *   reaches (`docs/qa/stack.md`, `## Data isolation`).
 *
 * Neither holds a loose parts lot: the parts list is `[PUB-20]`'s download. Each export logs
 * `export.downloaded` with the preset and the row count, never the file's content
 * (`docs/observability.md`).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { collectionItem } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { adminOperation, type AdminContext } from '../auth/admin-context';
import { database } from '../database';
import { logger, type Logger } from '../logger';
import type { PublicCatalogueData, PublicCondition, PublicKind } from '../publish/catalogue-data';
import { readCatalogueData, type PublishDatabase, type ValuesReader } from '../publish/projection';
import { readCollectionValues } from '../valuation/values';
import { writeCsv, type CsvCell } from './csv';

export const EXPORT_PRESETS = ['buyer', 'full'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

export const ExportInput = z.strictObject({ preset: z.enum(EXPORT_PRESETS) });
export type ExportInput = z.input<typeof ExportInput>;

/** The summary takes no options. */
export const SummaryInput = z.strictObject({});

export interface ExportedFile {
  /** `plinthos-{preset}-YYYY-MM-DD.csv`, the day in UTC ([EXP-4]). */
  readonly fileName: string;
  readonly csv: string;
  /** The rows under the header: one per item. */
  readonly rows: number;
}

/** What a file's kind and condition columns say: plain words a buyer reads, not the stored codes. */
const KIND_LABEL: Record<PublicKind, string> = { SET: 'Set', MINIFIG: 'Minifigure', BULK: 'Bulk lot', OTHER: 'Other' };
const CONDITION_LABEL: Record<PublicCondition, string> = { SEALED: 'Sealed', USED_WITH_BOX: 'Used, with box', USED_NO_BOX: 'Used, no box' };

/** The public fields every row of both presets starts with ([EXP-2]). */
const ITEM_HEADER = [
  'Kind',
  'Set number',
  'Name',
  'Reference number',
  'Theme',
  'Year',
  'Parts',
  'Approx. parts',
  'Approx. weight (g)',
  'Condition',
  'Complete',
  'Missing parts',
  'Instructions',
  'Description',
  'Quantity',
] as const;

/** The value columns of the buyer preset, only when the catalogue shows market values. */
const BUYER_VALUE_HEADER = ['Value', 'Value as of', 'Currency'] as const;

/** The full preset's columns after the public ones ([EXP-3]). */
const FULL_EXTRA_HEADER = [
  'Storage location',
  'Value override',
  'Override currency',
  'Value',
  'Value currency',
  'Value source',
  'Value as of',
  'Created',
  'Updated',
  'Id',
] as const;

interface ItemFields {
  readonly kind: PublicKind;
  readonly setNum: string | null;
  readonly name: string;
  readonly refNo: string | null;
  readonly theme: string | null;
  readonly year: number | null;
  readonly numParts: number | null;
  readonly approxParts: number | null;
  readonly approxWeightG: number | null;
  readonly condition: PublicCondition;
  readonly complete: boolean | null;
  readonly missingNotes: string | null;
  readonly hasInstructions: boolean | null;
  readonly description: string;
  readonly quantity: number;
}

function itemCells(item: ItemFields): CsvCell[] {
  return [
    KIND_LABEL[item.kind],
    item.setNum,
    item.name,
    item.refNo,
    item.theme,
    item.year,
    item.numParts,
    item.approxParts,
    item.approxWeightG,
    CONDITION_LABEL[item.condition],
    item.complete,
    item.missingNotes,
    item.hasInstructions,
    item.description,
    item.quantity,
  ];
}

/**
 * The buyer preset's file from the catalogue's data alone ([EXP-2]): pure, so `[PUB-4]`'s canary
 * test runs it over the data of every combination of the settings. The value columns are there
 * exactly when an item carries a value, which the projection gives only while the settings show
 * market values; otherwise they are absent, not empty.
 */
export function buyerCsv(data: PublicCatalogueData): { readonly csv: string; readonly rows: number } {
  const valued = data.items.some((item) => item.value !== undefined);
  const header = [...ITEM_HEADER, ...(valued ? BUYER_VALUE_HEADER : [])];
  const rows = data.items.map((item) => [
    ...itemCells(item),
    ...(valued ? [item.value, item.asOf, item.value === undefined ? null : data.valueCurrency] : []),
  ]);
  return { csv: writeCsv(header, rows), rows: rows.length };
}

/** The file's name: the preset and the day, in UTC ([EXP-4]). */
export function exportFileName(preset: ExportPreset, now: Date): string {
  return `plinthos-${preset}-${now.toISOString().slice(0, 10)}.csv`;
}

const bySetNumber = new Intl.Collator('en', { numeric: true });

export interface ExportDependencies {
  readonly database: () => PublishDatabase;
  readonly now?: () => Date;
  /** Where the values come from: `readCollectionValues` unless a test gives its own. */
  readonly readValues?: ValuesReader;
  readonly log?: Logger;
}

/** Builds the export over its database; deployed code uses `exportCollection` and `readCatalogueSummary` below. */
export function createExport(dependencies: ExportDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const readValues = dependencies.readValues ?? readCollectionValues;
  const log = dependencies.log ?? logger;

  /** The full preset ([EXP-3]): every item, every field entered, its value with source and date. */
  async function fullCsv(): Promise<{ readonly csv: string; readonly rows: number }> {
    const db = dependencies.database();
    const values = await readValues(db);
    const items = await db
      .select({
        id: collectionItem.id,
        kind: collectionItem.kind,
        setNum: collectionItem.setNum,
        ownName: collectionItem.name,
        refNo: collectionItem.refNo,
        approxParts: collectionItem.approxParts,
        approxWeightG: collectionItem.approxWeightG,
        condition: collectionItem.condition,
        complete: collectionItem.complete,
        missingNotes: collectionItem.missingNotes,
        hasInstructions: collectionItem.hasInstructions,
        description: collectionItem.description,
        quantity: collectionItem.quantity,
        storageLocation: collectionItem.storageLocation,
        manualValueOverride: collectionItem.manualValueOverride,
        manualValueCurrency: collectionItem.manualValueCurrency,
        createdAt: collectionItem.createdAt,
        updatedAt: collectionItem.updatedAt,
        setName: legoSet.name,
        theme: legoSet.theme,
        year: legoSet.year,
        numParts: legoSet.numParts,
      })
      .from(collectionItem)
      .leftJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum));
    const sorted = items
      .map((item) => ({ ...item, isSet: item.kind === 'SET', name: (item.kind === 'SET' ? item.setName : item.ownName) ?? item.setNum ?? '' }))
      // The catalogue's order: the sets by set number, then every other item by name.
      .sort(
        (a, b) =>
          Number(!a.isSet) - Number(!b.isSet) ||
          (a.isSet ? bySetNumber.compare(a.setNum ?? '', b.setNum ?? '') : bySetNumber.compare(a.name, b.name)) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const rows = sorted.map((item) => {
      const value = values.items.get(item.id) ?? null;
      return [
        ...itemCells({ ...item, theme: item.isSet ? item.theme : null, year: item.isSet ? item.year : null, numParts: item.isSet ? item.numParts : null }),
        item.storageLocation,
        item.manualValueOverride,
        item.manualValueOverride === null ? null : item.manualValueCurrency,
        value?.amount,
        value?.currency,
        value?.source,
        // A BrickLink value's quote day; the owner's own value has none.
        value?.asOf?.slice(0, 10),
        item.createdAt,
        item.updatedAt,
        item.id,
      ] satisfies CsvCell[];
    });
    return { csv: writeCsv([...ITEM_HEADER, ...FULL_EXTRA_HEADER], rows), rows: rows.length };
  }

  /** One of the two presets as a file, logged as `export.downloaded` with its preset and row count ([EXP-1]). */
  const exportCollection = adminOperation(ExportInput, async (admin: AdminContext, { preset }): Promise<ExportedFile> => {
    const at = now();
    const file =
      preset === 'buyer' ? buyerCsv(await readCatalogueData(dependencies.database(), { now: () => at, readValues })) : await fullCsv();
    log.info({ businessEvent: 'export.downloaded', preset, rows: file.rows, requestId: admin.requestId }, 'The collection was exported.');
    return { fileName: exportFileName(preset, at), csv: file.csv, rows: file.rows };
  });

  /** The printable summary's data ([EXP-5]): the catalogue as a publish would make it now. */
  const readCatalogueSummary = adminOperation(SummaryInput, async (): Promise<PublicCatalogueData> => {
    return readCatalogueData(dependencies.database(), { now, readValues });
  });

  return { exportCollection, readCatalogueSummary };
}

/** The export as deployed, over the Data API. */
export const { exportCollection, readCatalogueSummary } = createExport({ database });
