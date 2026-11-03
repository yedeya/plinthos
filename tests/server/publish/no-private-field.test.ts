import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { CLASSIFICATION } from '../../../src/db/schema/classification';
import { generateCatalogueToken } from '../../../src/server/publish/token';
import type { CollectionValues, ItemValue } from '../../../src/server/valuation/contract';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { anAdmin, MemoryStore, publisher } from './fakes';

/**
 * `[PUB-4]`: no private field's value appears anywhere in a generated snapshot. Every private
 * column of every table in the schema is filled with a canary, a value made for this run that
 * nothing else could produce, and every byte of every file the publish step writes is scanned for
 * each canary, as it is and in the encodings a page could carry it in. This runs for every
 * combination of `show_values`, `selling_mode` and `selling_value_display`, with the token made
 * on the publish and with one already stored.
 *
 * A boolean can't be a canary, so the switches are held a second way (#211): each combination
 * comes to what it shows, market values, asking prices and selling mode ([PUB-17], [PUB-18]),
 * and every combination that shows the same must write the same bytes, once each publish's
 * random photo paths are set aside. So Show values is held to nothing in selling mode, and a
 * display to nothing with selling mode off. A public column is filled with the same value in
 * every combination for that reason.
 *
 * **What is shown is asserted too, not only what is hidden.** The values come from
 * `readCollectionValues` (`src/server/valuation/`), which the publish takes as `readValues`: here
 * a reader whose every amount and date is a canary of its own, for the canary set (a BrickLink
 * value with its quote's instant), the bulk lot (the owner's estimate) and the loose parts. Each
 * combination names the needles it shows: the item and parts values only with market values, the
 * asking prices (`catalogue_settings.asking_price_*`, canaries like every private column) only in
 * selling mode with `ASKING` or `BOTH`, and a lot's unit price only in selling mode with market
 * values, from the lot's value by `[VAL-6]` the reader answers (#229), never the file's own unit
 * price, which stays refused under every setting. Every other needle stays refused in
 * every file, the shown ones in every combination that doesn't show them; and each shown one must
 * be in `catalogue.json` where the contract puts it. The quote's instant is never published, only
 * its day. The parts download, `parts.csv` and `parts.xml`, is scanned as every file is.
 * The file's currency is the canary with the token made on publish, and the deployment's with the
 * token already stored: the projection never reads it, so neither shows the file's prices.
 *
 * The snapshot has content (#162): the canary item, its set, a bulk lot, which names itself (#202), the texts and the item's photo,
 * whose stored sizes the publish copies into the snapshot (`[PUB-13]`). The fake photo bucket
 * holds a real WebP at each stored key the canary row names, and the scan covers the copies'
 * bytes and headers as it does every page, asset and `catalogue.json`. A stored key has a shape
 * the publish checks, so its canary is a key of that shape whose random part is the needle.
 *
 * `docs/qa/stack.md`'s `## Data isolation` holds this file. A new table needs nothing here; a
 * column of a type this test can't fill fails it, and the fix is to teach `canaryFor` the type.
 * A foreign key is filled with the canary of the row it names, and a table is filled after the
 * tables its required keys name; a nullable key into a table not filled yet is set once every
 * table is (`photo.item_id` and `collection_item.cover_photo_id` name each other, #124).
 *
 * A private text column with fixed values can't hold a canary, so it fails this test unless it is
 * named in `FIXED_PRIVATE` with the reason it needs none: today `parts_import.file_format`
 * (#161), which takes its first value, like a boolean, and `catalogue_settings.selling_value_display`,
 * which the matrix sets itself. Another such column fails until someone decides. The parts tables
 * are filled like any other (#161): the import's total value and every lot's unit price are
 * canaries; a lot's other columns are public since #211, published only in selling mode's
 * download, which the matrix asserts. `photo.parts_lot` stays false in the
 * canary row, because a photo belongs to an item or to the parts lot, never both, and the canary
 * row's photo names its item; its keys are canaries either way.
 *
 * The values (#207) are filled like any other column: a `price_quote` row, every price column of
 * it a canary, and each item's `manual_value_override` and its currency, the bulk lot's included,
 * whose value comes only from its override. The quote's item type, new-or-used and source are
 * fixed values, named in `FIXED_PRIVATE`; the per-condition adjustments are integers from -100 to
 * 100, too narrow for a canary, named in `BOUNDED_PRIVATE` with two values each, which the matrix
 * takes in turn, so its every-combination-writes-the-same-bytes check covers them.
 */

const tables = Object.values(schema) as PgTable[];

/** Every combination of the three settings: booleans, and each display choice and none. */
const SHOW_VALUES = [false, true];
const SELLING_MODE = [false, true];
const VALUE_DISPLAYS = [null, 'ASKING', 'MARKET', 'BOTH'] as const;
const TOKENS = ['made on publish', 'already stored'] as const;

type Matrix = { showValues: boolean; sellingMode: boolean; display: (typeof VALUE_DISPLAYS)[number]; token: (typeof TOKENS)[number] };
const matrix: Matrix[] = SHOW_VALUES.flatMap((showValues) =>
  SELLING_MODE.flatMap((sellingMode) =>
    VALUE_DISPLAYS.flatMap((display) => TOKENS.map((token) => ({ showValues, sellingMode, display, token }))),
  ),
);

/**
 * A value nothing else in the run could hold, of the column's type, and the strings that find it.
 * A public column only needs a value its checks accept: a public integer is small, and a public
 * text column with fixed values takes the first. A private one must be a canary.
 */
/**
 * The private columns with fixed values that hold no canary, each with its reason. Every other
 * private fixed-value column fails `canaryFor` until it is taught to find one or named here.
 */
const FIXED_PRIVATE: ReadonlyMap<string, string> = new Map([
  ['parts_import.file_format', 'which of two file formats was imported (BSX or BL_XML); it reveals nothing about the lots'],
  ['catalogue_settings.selling_value_display', 'the matrix sets it to each display and none, and asserts what each shows'],
  // The quote's key and source (#207): its price, sample size, item number, currency, dates and error are canaries.
  ['price_quote.item_type', 'a quote is for a SET or a MINIFIG, which the public item kind already says; every price column is a canary'],
  ['price_quote.new_or_used', 'a quote is N or U, too short to be a needle; every price column is a canary'],
  ['price_quote.source', 'every quote is BrickLink’s, a fact the brief states; every price column is a canary'],
  // The parts lots' quotes (#226): their price, sample size, item number, colour, currency, dates and error are canaries.
  ['part_price_quote.item_type', 'one of BrickLink’s eight type names, which a lot’s public item type already says; every price column is a canary'],
  ['part_price_quote.new_or_used', 'a quote is N or U, too short to be a needle; every price column is a canary'],
  ['part_price_quote.source', 'every quote is BrickLink’s, a fact the brief states; every price column is a canary'],
  // The refresh's runs (#226): the job's own state, which no value is derived from; their counts and dates are canaries.
  ['price_refresh_run.scope', 'which of three scopes a refresh asked for (items, parts or all); it reveals nothing about the collection'],
  ['price_refresh_run.state', 'whether a refresh runs or has ended, of three states; it reveals nothing about the collection'],
  ['price_refresh_run.stop_reason', 'why a refresh stopped, of a fixed few reasons; it reveals nothing about the collection'],
]);

/**
 * The private integers held to a narrow range, which can't hold a nine-digit canary (#207): the
 * value adjustments, from -100 to 100. A value this short would be no needle, so the matrix holds
 * them the way it holds the switches: each combination takes one of two values for each, in turn,
 * and every combination must write the same bytes, so a snapshot that depended on an adjustment
 * would fail. Another such column fails `canaryFor` until it is named here, with its two values.
 */
const BOUNDED_PRIVATE: ReadonlyMap<string, readonly [number, number]> = new Map([
  ['catalogue_settings.adjust_used_with_box_pct', [-37, 64]],
  ['catalogue_settings.adjust_used_no_box_pct', [59, -12]],
]);
/** The columns whose values have the shape of a stored photo key, which the publish checks ([PHOTO-6]). */
const STORED_KEY_COLUMNS = new Set(['photo.full_key', 'photo.thumbnail_key']);

/** A public UUID that stays the same in every combination of the run, so the outputs compare. */
function publicUuid(table: string, column: string): string {
  const hex = createHash('sha256').update(`${RUN}-${table}-${column}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const RUN = randomBytes(6).toString('hex');

function canaryFor(table: string, column: PgColumn, index: number, visibility: 'public' | 'private'): { value: unknown; needles: string[] } {
  const marker = `canary-${table}-${column.name}-${randomBytes(6).toString('hex')}`;
  const fixed = (column as { enumValues?: readonly string[] }).enumValues;
  switch (column.columnType) {
    case 'PgText':
    case 'PgVarchar':
      if (fixed !== undefined && fixed.length > 0) {
        if (visibility === 'private' && !FIXED_PRIVATE.has(`${table}.${column.name}`)) {
          throw new Error(`${table}.${column.name} is private with fixed values: teach canaryFor in this test to find one`);
        }
        return { value: fixed[0], needles: [] };
      }
      if (STORED_KEY_COLUMNS.has(`${table}.${column.name}`)) {
        if (visibility === 'public') throw new Error(`${table}.${column.name} is a private object's key: it must stay private`);
        const random = randomBytes(32).toString('base64url');
        const key = `photos/${random}.webp`;
        return { value: key, needles: [key, random] };
      }
      // A public text is the same in every combination; a private one is a canary.
      if (visibility === 'public') return { value: `public ${table} ${column.name}`, needles: [] };
      return { value: marker, needles: [marker] };
    case 'PgInteger': {
      if (visibility === 'public') return { value: 1 + index, needles: [] };
      const bounded = BOUNDED_PRIVATE.get(`${table}.${column.name}`);
      if (bounded !== undefined) return { value: bounded[0], needles: [] };
      // Nine digits that start with 7 and nothing else in the run produces.
      const value = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10 + (index % 10);
      return { value, needles: [String(value)] };
    }
    case 'PgUUID': {
      if (visibility === 'public') return { value: publicUuid(table, column.name), needles: [] };
      const uuid = randomUUID();
      return { value: uuid, needles: [uuid, uuid.replaceAll('-', '')] };
    }
    case 'PgTimestamp': {
      // A different made-up instant per column, years from anything the clock produces.
      const date = new Date(Date.UTC(1971, 2, 3, 4, 5, 6, 7 + index));
      return { value: date, needles: [date.toISOString(), String(date.getTime()), date.toISOString().slice(0, 19)] };
    }
    case 'PgNumeric':
    case 'PgNumericNumber': {
      // Nine digits that start with 7, then three decimals, which nothing else in the run produces.
      const whole = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10 + (index % 10);
      const value = `${whole}.${String(100 + (index % 900)).padStart(3, '0')}`;
      // Also as a page would format it, with thousands separators.
      return { value: column.columnType === 'PgNumericNumber' ? Number(value) : value, needles: [String(whole), whole.toLocaleString('en')] };
    }
    case 'PgBoolean':
      // A photo belongs to an item or to the parts lot, never both: the canary row's photo names its item.
      return { value: !(table === 'photo' && column.name === 'parts_lot'), needles: [] };
    default:
      throw new Error(`${table}.${column.name} is a ${column.columnType}: teach canaryFor in this test to fill it with a canary`);
  }
}

/** Every way a needle could sit in a file: as it is, URL-encoded, in base64 and in hex. */
function encodings(needle: string): string[] {
  const bytes = Buffer.from(needle);
  return [needle, encodeURIComponent(needle), bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex')];
}

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});

/** The property of a Drizzle table that holds a column. */
function keyOf(table: PgTable, column: PgColumn): string {
  const key = Object.entries(table).find(([, candidate]) => candidate === column)?.[0];
  if (key === undefined) throw new Error(`no property of ${getTableConfig(table).name} holds ${column.name}`);
  return key;
}

/**
 * The tables in an order that fills each after the tables its foreign keys name, where it can, and
 * after those its required keys name always. A nullable key may still need its value at insert:
 * `collection_item.set_num` is nullable since #202, but a set's row must name its set
 * (`collection_item_kind_identity_check`). So a nullable key is put off only to break a cycle.
 */
function fillOrder(): PgTable[] {
  const order: PgTable[] = [];
  const pending = [...tables];
  const references = (table: PgTable) => getTableConfig(table).foreignKeys.map((key) => key.reference());
  while (pending.length > 0) {
    let next = pending.findIndex((table) => references(table).every((reference) => reference.foreignTable === table || order.includes(reference.foreignTable)));
    if (next === -1) {
      next = pending.findIndex((table) => references(table).every((reference) => reference.columns.every((column) => !column.notNull) || order.includes(reference.foreignTable)));
    }
    if (next === -1) throw new Error('the required foreign keys form a cycle: teach fillOrder in this test to break it');
    order.push(...pending.splice(next, 1));
  }
  return order;
}

/** The nullable keys into a table filled after their own, which the fill sets last and the emptying clears first. */
function deferredKeys(): Map<PgTable, PgColumn[]> {
  const order = fillOrder();
  const deferred = new Map<PgTable, PgColumn[]>();
  for (const [index, table] of order.entries()) {
    const columns = getTableConfig(table)
      .foreignKeys.map((key) => key.reference())
      .filter((reference) => !order.slice(0, index).includes(reference.foreignTable))
      .flatMap((reference) => reference.columns);
    if (columns.length > 0) deferred.set(table, columns);
  }
  return deferred;
}

/**
 * Empties every table, in one round trip: the deferred keys first, which may name each other, then
 * each table before the tables its keys name. A `truncate` of every table took most of a
 * combination's time (#140), and deleting the one row each holds does the same work.
 */
function emptyEveryTable(): string {
  const nullable = [...deferredKeys()].map(([table, columns]) => `update "${getTableConfig(table).name}" set ${columns.map((column) => `"${column.name}" = null`).join(', ')}`);
  const deletes = fillOrder()
    .reverse()
    .map((table) => `delete from "${getTableConfig(table).name}"`);
  return [...nullable, ...deletes].join(';\n');
}

/** Empties every table and fills one row of each with canaries; returns the needles of the private ones. */
async function fillWithCanaries(case_: Matrix): Promise<{ needles: string[]; token: string | null }> {
  const needles: string[] = [];
  let token: string | null = null;
  await fresh.client.query(emptyEveryTable());
  const left = await fresh.client.query<{ rows: string }>(
    `select ${tables.map((table) => `(select count(*) from "${getTableConfig(table).name}")`).join(' + ')} as rows`,
  );
  if (Number(left.rows[0]?.rows) !== 0) throw new Error(`${left.rows[0]?.rows} rows outlived emptying every table`);
  const rows = new Map<PgTable, Record<string, unknown>>();
  for (const table of tables) {
    const config = getTableConfig(table);
    const row: Record<string, unknown> = {};
    config.columns.forEach((column, index) => {
      const visibility = CLASSIFICATION[config.name]?.[column.name]?.visibility;
      if (visibility === undefined) throw new Error(`${config.name}.${column.name} has no classification ([PUB-3])`);
      const { value, needles: found } = canaryFor(config.name, column, index, visibility);
      row[keyOf(table, column)] = value;
      if (visibility === 'private') needles.push(...found);
    });
    rows.set(table, row);
  }
  // A foreign key holds the canary of the row it names.
  for (const table of tables) {
    for (const key of getTableConfig(table).foreignKeys) {
      const reference = key.reference();
      reference.columns.forEach((column, index) => {
        const target = reference.foreignColumns[index];
        if (target === undefined) throw new Error('a foreign key with no column it names');
        const row = rows.get(table);
        const named = rows.get(reference.foreignTable);
        if (row === undefined || named === undefined) throw new Error('a foreign key into a table not in the schema');
        row[keyOf(table, column)] = named[keyOf(reference.foreignTable, target)];
      });
    }
  }
  const filled: PgTable[] = [];
  const later: (() => Promise<unknown>)[] = [];
  for (const table of fillOrder()) {
    const config = getTableConfig(table);
    const row = rows.get(table) ?? {};
    if (config.name === 'catalogue_settings') {
      row.showValues = case_.showValues;
      row.sellingMode = case_.sellingMode;
      // The bounded private columns take their two values in turn across the matrix ([PUB-4], #207).
      const variant = Math.max(0, matrix.indexOf(case_)) % 2;
      for (const column of config.columns) {
        const values = BOUNDED_PRIVATE.get(`${config.name}.${column.name}`);
        if (values !== undefined) row[keyOf(table, column)] = values[variant];
      }
      row.sellingValueDisplay = case_.display;
      // The token is the snapshot's address: it may be the path, never content in a file.
      token = case_.token === 'already stored' ? generateCatalogueToken() : null;
      row.publicToken = token;
    }
    // A nullable key into a table not filled yet is set once every table is.
    const deferred: Record<string, unknown> = {};
    for (const column of deferredKeys().get(table) ?? []) {
      deferred[keyOf(table, column)] = row[keyOf(table, column)];
      row[keyOf(table, column)] = null;
    }
    await fresh.db.insert(table).values(row);
    filled.push(table);
    if (Object.keys(deferred).length > 0) later.push(() => fresh.db.update(table).set(deferred));
  }
  for (const update of later) await update();
  needles.push(...(await addPartsLotPhoto()));
  needles.push(...(await addNonSetItem()));
  // The file's prices in the deployment's currency, for one token of each pair: no byte may depend on it (see the header).
  if (case_.token === 'already stored') await fresh.db.update(schema.partsImport).set({ currency: DEPLOYMENT_CURRENCY });
  return { needles, token };
}

/**
 * The canary row of `collection_item` is a set, the kind its fixed values start with, because a
 * set must name its set (#202). So a second item, a bulk lot, is added with the columns only a
 * non-set fills, its own name, reference number and approximate pieces and weight, public and the
 * same in every combination, and every private column a canary of its own. Returns its needles.
 */
async function addNonSetItem(): Promise<string[]> {
  const storageLocation = `canary-collection_item-bulk-storage_location-${randomBytes(6).toString('hex')}`;
  const version = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10 + 8;
  const createdAt = new Date(Date.UTC(1971, 5, 6, 7, 8, 9, 10));
  const updatedAt = new Date(Date.UTC(1971, 6, 7, 8, 9, 10, 11));
  // A bulk lot's value comes only from its override (#207, VAL-5): its own canaries.
  const overrideWhole = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10 + 9;
  const overrideCurrency = `canary-collection_item-bulk-manual_value_currency-${randomBytes(6).toString('hex')}`;
  await fresh.db.insert(schema.collectionItem).values({
    id: publicUuid('collection_item', 'bulk lot'),
    kind: 'BULK',
    setNum: null,
    name: 'public bulk lot name',
    refNo: 'public-bulk-ref',
    approxParts: 2,
    approxWeightG: 3,
    condition: 'USED_NO_BOX',
    complete: null,
    missingNotes: null,
    hasInstructions: null,
    description: 'public bulk lot description',
    quantity: 1,
    storageLocation,
    coverPhotoId: null,
    manualValueOverride: Number(`${overrideWhole}.250`),
    manualValueCurrency: overrideCurrency,
    version,
    createdAt,
    updatedAt,
  });
  return [storageLocation, String(version), String(overrideWhole), overrideCurrency, ...[createdAt, updatedAt].flatMap((date) => [date.toISOString(), String(date.getTime()), date.toISOString().slice(0, 19)])];
}

/**
 * The canary row's photo names its item, and a photo is an item's or the parts lot's, never both
 * (#161): so a second photo, the parts lot's overview photo, is added with canaries of its own
 * (`[PUB-13]`, `[PUB-14]`). Returns its needles.
 */
async function addPartsLotPhoto(): Promise<string[]> {
  const key = () => randomBytes(32).toString('base64url');
  const full = key();
  const thumb = key();
  const id = randomUUID();
  const sha256 = `canary-photo-sha256-${randomBytes(6).toString('hex')}`;
  const position = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10 + 7;
  const createdAt = new Date(Date.UTC(1971, 4, 5, 6, 7, 8, 9));
  await fresh.db.insert(schema.photo).values({
    id,
    fullKey: `photos/${full}.webp`,
    thumbnailKey: `photos/${thumb}.webp`,
    sha256,
    createdAt,
    itemId: null,
    position,
    partsLot: true,
  });
  return [`photos/${full}.webp`, full, `photos/${thumb}.webp`, thumb, id, id.replaceAll('-', ''), sha256, String(position), createdAt.toISOString(), String(createdAt.getTime())];
}

/** A tiny real WebP, with no metadata, as a stored size is ([PHOTO-4]). */
const WEBP = sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 40, b: 30 } } })
  .webp()
  .toBuffer()
  .then((buffer) => new Uint8Array(buffer));

/** Puts a stored size in the fake photo bucket at every key the photo table names. */
async function storePhotos(store: MemoryStore): Promise<void> {
  const body = await WEBP;
  for (const row of await fresh.db.select({ fullKey: schema.photo.fullKey, thumbnailKey: schema.photo.thumbnailKey }).from(schema.photo)) {
    for (const key of [row.fullKey, row.thumbnailKey]) store.photos.set(key, { body, contentType: 'image/webp', cacheControl: 'private, max-age=600' });
  }
}

/**
 * The matrix publishes once per combination, so it runs well past one publish's time: on CI it
 * took 1.8 s and once reached vitest's 5 s default with no assertion failing (#140). Its own limit
 * keeps a slow runner from failing it; a hang still fails.
 */
const MATRIX_TIMEOUT_MS = 60_000;

/** The deployment's currency the values reader answers with. */
const DEPLOYMENT_CURRENCY = 'EUR';

/** An amount nothing else in the run produces: nine digits that start with 7, and cents. */
function canaryAmount(cents: number): { amount: number; needles: string[] } {
  const whole = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10;
  return { amount: whole + cents / 100, needles: [String(whole), whole.toLocaleString('en')] };
}

/**
 * The values `readCollectionValues` would answer, every amount and instant a canary of this run:
 * the canary set's BrickLink value with its quote's instant, the bulk lot's override, the loose
 * parts' value, and the canary lot's value by `[VAL-6]` (#229), whose unit price in the download is
 * a canary of its own: the lot's value is that price × the lot's quantity. Records how often it is read.
 */
function canaryValues() {
  const set = canaryAmount(25);
  const bulk = canaryAmount(50);
  const parts = canaryAmount(75);
  const lotPrice = canaryAmount(33);
  const quotedAt = new Date(Date.UTC(1972, 7, 9, 10, 11, 12, 13));
  const setId = publicUuid('collection_item', 'id');
  const bulkId = publicUuid('collection_item', 'bulk lot');
  const reads = { count: 0 };
  return {
    readValues: async (): Promise<CollectionValues> => {
      reads.count += 1;
      const lots = await fresh.db.select({ id: schema.partsLot.id, quantity: schema.partsLot.lotQuantity }).from(schema.partsLot);
      return {
        items: new Map<string, ItemValue | null>([
          [setId, { amount: set.amount, currency: DEPLOYMENT_CURRENCY, source: 'bricklink', asOf: quotedAt.toISOString() }],
          [bulkId, { amount: bulk.amount, currency: DEPLOYMENT_CURRENCY, source: 'override', asOf: null }],
        ]),
        parts: { amount: parts.amount, currency: DEPLOYMENT_CURRENCY, fromBrickLink: 1, fromFile: 0, none: 0 },
        partsLots: new Map(lots.map((lot) => [lot.id, lotPrice.amount * lot.quantity])),
        currency: DEPLOYMENT_CURRENCY,
      };
    },
    reads,
    set,
    bulk,
    parts,
    lotPrice,
    quotedDay: quotedAt.toISOString().slice(0, 10),
    // The quote's instant is never published, under any setting: only its day.
    neverNeedles: [quotedAt.toISOString(), String(quotedAt.getTime()), quotedAt.toISOString().slice(0, 19)],
  };
}

/** What a combination shows ([PUB-17], [PUB-18]): the settings' effect, which the snapshot must follow exactly. */
function shownBy(case_: Matrix): { market: boolean; asking: boolean; selling: boolean; prices: boolean } {
  const display = case_.sellingMode ? (case_.display ?? 'ASKING') : null;
  const market = case_.sellingMode ? display !== 'ASKING' : case_.showValues;
  const asking = case_.sellingMode && display !== 'MARKET';
  // A lot's unit price: in selling mode with market values, from the lot's value by [VAL-6] (#229), never the file's own price.
  return { market, asking, selling: case_.sellingMode, prices: case_.sellingMode && market };
}

/** The canary row's asking prices, as stored, with the needles each holds. */
async function askingCanaries(needles: readonly string[]) {
  const [row] = await fresh.db
    .select({ total: schema.catalogueSettings.askingPriceTotal, sealed: schema.catalogueSettings.askingPriceSealed, used: schema.catalogueSettings.askingPriceUsed, parts: schema.catalogueSettings.askingPriceParts })
    .from(schema.catalogueSettings);
  if (row === undefined) throw new Error('no settings row');
  const of = (amount: number | null) => {
    const whole = String(Math.trunc(Number(amount)));
    expect(needles, whole).toContain(whole);
    return [whole, Number(whole).toLocaleString('en')];
  };
  return { row, needles: [row.total, row.sealed, row.used, row.parts].flatMap(of) };
}

/** The canary lot's unit price as stored, and its needles. */
async function unitPriceCanary(needles: readonly string[]) {
  const [lot] = await fresh.db.select().from(schema.partsLot);
  const whole = String(Math.trunc(Number(lot?.unitPrice)));
  expect(needles, whole).toContain(whole);
  return { lot, needles: [whole, Number(whole).toLocaleString('en')] };
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
}

interface Snapshot {
  items: (Record<string, unknown> & { kind: string; photos: unknown[] })[];
  parts: (Record<string, unknown> & { lots: number; quantity: number; photos: unknown[]; list?: Record<string, unknown>[] }) | null;
  valueCurrency?: string;
  totals?: Record<string, number>;
  asking?: Record<string, number>;
  segments?: string[];
}

/** The keys a published item has under every setting (format 4). */
const ITEM_KEYS = ['approxParts', 'approxWeightG', 'complete', 'condition', 'description', 'hasInstructions', 'id', 'kind', 'missingNotes', 'name', 'numParts', 'photos', 'quantity', 'refNo', 'setNum', 'stockImageUrl', 'theme', 'year'];

describe('the generated snapshot', () => {
  it('[PUB-4] [PUB-17] [PUB-18] [PUB-19] [PUB-20] holds no private field’s value, for every setting, in any file, in any encoding, and shows exactly what the settings show', { timeout: MATRIX_TIMEOUT_MS }, async () => {
    const outputs = new Map<string, Set<string>>();
    const adjustments = new Set<string>();
    for (const case_ of matrix) {
      const label = JSON.stringify(case_);
      const shown = shownBy(case_);
      const { needles, token: stored } = await fillWithCanaries(case_);
      const [filled] = await fresh.db.select().from(schema.catalogueSettings);
      adjustments.add(`${filled?.adjustUsedWithBoxPct} ${filled?.adjustUsedNoBoxPct}`);
      const values = canaryValues();
      const asking = await askingCanaries(needles);
      const price = await unitPriceCanary(needles);
      const { publish, store } = publisher(fresh.db, { now: () => new Date('2026-11-01T12:00:00.000Z'), readValues: values.readValues });
      await storePhotos(store);
      const result = await publish(anAdmin(), {});
      expect(result.status, label).toBe('published');
      // The values are read only when the settings show something.
      expect(values.reads.count, label).toBe(shown.market || shown.asking ? 1 : 0);

      const [settings] = await fresh.db.select().from(schema.catalogueSettings);
      const token = settings?.publicToken ?? '';
      if (stored !== null) expect(token).toBe(stored);
      const valueNeedles = [...values.set.needles, ...values.bulk.needles, ...values.parts.needles];
      // What this combination may show; everything else, the token and the file's own unit price included, is refused in every file.
      const allowed = new Set([...(shown.market ? valueNeedles : []), ...(shown.asking ? asking.needles : []), ...(shown.prices ? values.lotPrice.needles : [])]);
      const refused = [...needles, ...valueNeedles, ...values.lotPrice.needles, ...price.needles, ...values.neverNeedles, token].filter((needle) => !allowed.has(needle));
      expect(store.objects.size).toBeGreaterThan(0);
      for (const [key, object] of store.objects) {
        expect(key.startsWith(`c/${token}/`), key).toBe(true);
        const text = [object.contentType, object.cacheControl, Buffer.from(object.body).toString('latin1')].join('\n');
        for (const needle of refused) {
          for (const encoded of encodings(needle)) expect(text.includes(encoded), `${key} holds ${needle} (${label})`).toBe(false);
        }
      }
      const file = (name: string) => {
        const object = store.objects.get(`c/${token}/${name}`);
        return object === undefined ? undefined : Buffer.from(object.body).toString();
      };
      const catalogue = JSON.parse(file('catalogue.json') ?? '{}') as Snapshot;
      const keys = keysOf(catalogue);

      // The canary item is published with its photo, both sizes copied, so the scan covered them;
      // and the bulk lot after it, with the fields only a non-set has (#202).
      expect(catalogue.items).toHaveLength(2);
      const [set, bulk] = catalogue.items;
      expect(set).toMatchObject({ kind: 'SET', condition: 'SEALED' });
      expect(set?.photos).toHaveLength(1);
      expect(bulk).toMatchObject({ kind: 'BULK', setNum: null, name: 'public bulk lot name', refNo: 'public-bulk-ref', approxParts: 2, approxWeightG: 3, photos: [] });
      const itemKeys = [...ITEM_KEYS, ...(shown.market ? ['asOf', 'value'] : []), ...(shown.selling ? ['segment'] : [])].sort();
      for (const item of catalogue.items) expect(Object.keys(item).sort(), label).toEqual(itemKeys);

      // [PUB-17] [PUB-18] Market values: each item's, dated by its quote's day or the publish's, the parts' and the totals; else none, not even a key.
      if (shown.market) {
        expect(set?.value, label).toBe(values.set.amount);
        expect(set?.asOf, label).toBe(values.quotedDay);
        expect(bulk?.value, label).toBe(values.bulk.amount);
        expect(bulk?.asOf, label).toBe('2026-11-01');
        expect(catalogue.parts?.value, label).toBe(values.parts.amount);
        const partsTotal = Math.round((values.parts.amount + values.bulk.amount) * 100) / 100;
        expect(catalogue.totals, label).toEqual({ all: Math.round((values.set.amount + partsTotal) * 100) / 100, sealed: values.set.amount, parts: partsTotal });
        expect(catalogue.valueCurrency, label).toBe(DEPLOYMENT_CURRENCY);
        expect(file('index.html'), label).toContain('<option value="value">');
        expect(file('index.html'), label).toContain('data-value=');
      } else {
        for (const key of ['value', 'asOf', 'totals']) expect(keys, `${key} (${label})`).not.toContain(key);
        for (const name of [...store.objects.keys()].filter((key) => key.endsWith('.html'))) {
          const page = Buffer.from(store.objects.get(name)?.body ?? []).toString();
          expect(page, name).not.toContain('data-value');
          expect(page, name).not.toContain('<option value="value">');
        }
      }
      // [PUB-18] The asking prices only in selling mode with ASKING or BOTH: every one entered, overall and per segment.
      if (shown.asking) {
        expect(catalogue.asking, label).toEqual({ total: asking.row.total, sealed: asking.row.sealed, used: asking.row.used, parts: asking.row.parts });
        expect(catalogue.valueCurrency, label).toBe(DEPLOYMENT_CURRENCY);
      } else {
        expect(keys, label).not.toContain('asking');
      }
      if (!shown.market && !shown.asking) expect(keys, label).not.toContain('valueCurrency');

      // [PUB-19] [PUB-20] Selling mode: the split views with anything in them, and the parts download from the stored lots.
      const csv = file('parts.csv');
      const xml = file('parts.xml');
      if (shown.selling) {
        expect(catalogue.segments, label).toEqual(['sealed', 'parts']);
        expect(set?.segment).toBe('sealed');
        expect(bulk?.segment).toBe('parts');
        expect(file('sealed/index.html'), label).toBeDefined();
        expect(file('parts/index.html'), label).toContain('public bulk lot name');
        expect(file('used/index.html'), label).toBeUndefined();
        const lot = price.lot;
        const header = ['Item type', 'Item number', 'Color ID', 'Condition', 'Quantity', ...(shown.prices ? [`Unit price (${DEPLOYMENT_CURRENCY})`] : [])];
        const row = [lot?.itemType, lot?.itemNo, String(lot?.colorId), lot?.lotCondition, String(lot?.lotQuantity), ...(shown.prices ? [String(values.lotPrice.amount)] : [])];
        expect(csv, label).toBe(`${header.join(',')}\r\n${row.join(',')}\r\n`);
        expect(xml, label).toContain(`<ITEMID>${lot?.itemNo ?? ''}</ITEMID>`);
        expect(xml?.includes('<PRICE>'), label).toBe(shown.prices);
        expect(catalogue.parts?.list, label).toEqual([{ type: lot?.itemType, no: lot?.itemNo, color: lot?.colorId, condition: lot?.lotCondition, quantity: lot?.lotQuantity, ...(shown.prices ? { price: values.lotPrice.amount } : {}) }]);
      } else {
        expect(keys, label).not.toContain('segments');
        expect(keys, label).not.toContain('segment');
        expect(keys, label).not.toContain('list');
        for (const name of ['parts.csv', 'parts.xml', 'sealed/index.html', 'used/index.html']) expect(file(name), `${name} (${label})`).toBeUndefined();
        // [PUB-14] No lot is published with selling mode off: its public item number is in no file.
        for (const [key, object] of store.objects) expect(Buffer.from(object.body).toString('latin1'), key).not.toContain('public parts_lot item_no');
      }

      // [PUB-14] The parts summary: the import's two counts and the overview photo, and only what the settings add.
      const [parts] = await fresh.db.select({ lots: schema.partsImport.lots, quantity: schema.partsImport.quantity }).from(schema.partsImport);
      expect(catalogue.parts).toMatchObject({ lots: parts?.lots, quantity: parts?.quantity, photos: [expect.any(Object)] });
      expect(Object.keys(catalogue.parts ?? {}).sort()).toEqual(['lots', 'photos', 'quantity', ...(shown.selling ? ['list'] : []), ...(shown.market ? ['value'] : [])].sort());
      // [PUB-13] The item's photo and the parts lot's, both sizes each, copied.
      expect(store.copied).toHaveLength(4);
      const effect = JSON.stringify(shown);
      const seen = outputs.get(effect) ?? new Set<string>();
      seen.add(
        JSON.stringify(store.snapshot())
          .replaceAll(token, '{token}')
          .replace(/p\/[A-Za-z0-9_-]{43}\.webp/g, 'p/{photo}.webp')
          // The canary amounts are new each combination; their places are asserted above.
          .replace(/\d{1,3}(?:,\d{3}){2,3}(?:\.\d+)?|\d{9,10}(?:\.\d+)?/g, '{amount}'),
      );
      outputs.set(effect, seen);
    }
    // Every combination that shows the same wrote the same bytes: the switches have no effect but what they show.
    for (const [effect, seen] of outputs) expect(seen.size, effect).toBe(1);
    // Off; Show values; and in selling mode ASKING, MARKET and BOTH. The file's currency changes no byte (#229).
    expect([...outputs.keys()].length).toBe(5);
    // The value adjustments took both their values across the matrix, and changed no byte within an effect (#207).
    expect(adjustments.size).toBe(2);
  });

  it('[PUB-4] [PUB-14] with selling mode off holds no unit price, total value or currency of the parts, and no lot', async () => {
    const { needles } = await fillWithCanaries({ showValues: true, sellingMode: false, display: 'BOTH', token: 'made on publish' });
    const [lot] = await fresh.db.select().from(schema.partsLot);
    const [parts] = await fresh.db.select().from(schema.partsImport);
    // Each of them is a canary the matrix above scans every file for, in every encoding.
    const whole = (value: unknown) => String(Math.trunc(Number(value)));
    for (const value of [whole(lot?.unitPrice), whole(parts?.totalValue), parts?.currency, lot?.id, lot?.importId]) {
      expect(needles, String(value)).toContain(value);
    }
    const { publish, store } = publisher(fresh.db);
    await storePhotos(store);
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'published' });
    const json = [...store.objects].find(([key]) => key.endsWith('catalogue.json'))?.[1];
    const catalogue = JSON.parse(Buffer.from(json?.body ?? []).toString()) as { parts: Record<string, unknown> };
    // The summary carries the counts and the photos, and no field of a lot.
    expect(Object.keys(catalogue.parts).sort()).toEqual(['lots', 'photos', 'quantity']);
    for (const [key, object] of store.objects) {
      const text = Buffer.from(object.body).toString('latin1');
      for (const value of [lot?.itemNo, lot?.itemType]) expect(text, key).not.toContain(value);
    }
  });

  it('[PUB-4] [PUB-13] the snapshot names no stored photo key, and every copy is under a new random path', async () => {
    const { needles } = await fillWithCanaries({ showValues: false, sellingMode: false, display: null, token: 'made on publish' });
    const { publish, store } = publisher(fresh.db);
    await storePhotos(store);
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'published' });
    // The item's photo and the parts lot's overview photo.
    const rows = await fresh.db.select().from(schema.photo);
    expect(rows).toHaveLength(2);
    const stored = rows.flatMap((row) => [row.fullKey, row.thumbnailKey]);
    expect(needles).toEqual(expect.arrayContaining(stored));
    expect(store.copied.map(({ from }) => from).sort()).toEqual([...stored].sort());
    for (const { from, to } of store.copied) {
      expect(to).toMatch(/^c\/[A-Za-z0-9_-]{43}\/p\/[A-Za-z0-9_-]{43}\.webp$/);
      // The random part of the public path is not the stored key's.
      expect(from.slice('photos/'.length)).not.toBe(to.split('/p/')[1]);
    }
  });

  it('[PUB-4] names no private column, in either case, as a key of its JSON, with every value field present', async () => {
    const { publish, store } = publisher(fresh.db, { readValues: canaryValues().readValues });
    await fillWithCanaries({ showValues: true, sellingMode: true, display: 'BOTH', token: 'already stored' });
    await storePhotos(store);
    await publish(anAdmin(), {});
    const json = [...store.objects].find(([key]) => key.endsWith('.json'))?.[1];
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        keys.push(key);
        walk(inner);
      }
    };
    walk(JSON.parse(Buffer.from(json?.body ?? []).toString()));
    const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const names = (visibility: 'public' | 'private') =>
      Object.values(CLASSIFICATION).flatMap((columns) =>
        Object.entries(columns)
          .filter(([, classified]) => classified.visibility === visibility)
          .flatMap(([name]) => [name, camel(name)]),
      );
    // A name that is a public column of a table the catalogue publishes is a public field: an item
    // has an `id` (`collection_item.id`) and a `name` (`lego_set.name`), though another table's
    // `id` or `name` is private. Every other private column's name stays refused, and the canaries
    // above hold the values whatever the keys.
    const publicNames = new Set(names('public'));
    const privateNames = names('private').filter((name) => !publicNames.has(name));
    expect(keys.length).toBeGreaterThan(0);
    // Every field the settings can add is here, so each is checked (#211).
    for (const key of ['value', 'asOf', 'segment', 'valueCurrency', 'totals', 'asking', 'segments', 'list', 'price']) expect(keys, key).toContain(key);
    for (const key of keys) expect(privateNames, key).not.toContain(key);
  });

  it('[PUB-4] covers every table of the schema and every private column with a canary', async () => {
    const { needles } = await fillWithCanaries({ showValues: false, sellingMode: false, display: null, token: 'made on publish' });
    const privateNonBoolean = tables.flatMap((table) => {
      const config = getTableConfig(table);
      return config.columns.filter(
        (column) =>
          CLASSIFICATION[config.name]?.[column.name]?.visibility === 'private' &&
          column.columnType !== 'PgBoolean' &&
          !FIXED_PRIVATE.has(`${config.name}.${column.name}`) &&
          !BOUNDED_PRIVATE.has(`${config.name}.${column.name}`),
      );
    });
    // At least one needle per private column, booleans and the named fixed-value columns aside.
    expect([...FIXED_PRIVATE.keys()].every((name) => tables.some((table) => getTableConfig(table).name === name.split('.')[0]))).toBe(true);
    for (const name of ['parts_import', 'parts_lot', 'price_quote']) expect(tables.map((table) => getTableConfig(table).name)).toContain(name);
    // Every bounded column named exists, and every value column of #207 is a canary: the quote's price, the override.
    for (const name of BOUNDED_PRIVATE.keys()) {
      const [table, column] = name.split('.');
      expect(tables.some((candidate) => getTableConfig(candidate).name === table && getTableConfig(candidate).columns.some((own) => own.name === column)), name).toBe(true);
    }
    const [quote] = await fresh.db.select().from(schema.priceQuote);
    const items = await fresh.db.select().from(schema.collectionItem);
    for (const value of [quote?.average, quote?.sampleSize, ...items.map((item) => item.manualValueOverride)]) expect(needles, String(value)).toContain(String(Math.trunc(Number(value))));
    for (const value of [quote?.itemNo, quote?.currency, quote?.lastError, ...items.map((item) => item.manualValueCurrency)]) expect(needles).toContain(value);
    expect(needles.length).toBeGreaterThanOrEqual(privateNonBoolean.length);
    expect(matrix).toHaveLength(SHOW_VALUES.length * SELLING_MODE.length * VALUE_DISPLAYS.length * TOKENS.length);
  });
});
