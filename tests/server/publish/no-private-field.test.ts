import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { CLASSIFICATION } from '../../../src/db/schema/classification';
import { generateCatalogueToken } from '../../../src/server/publish/token';
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
 * A boolean can't be a canary, so the switches are held a second way: the catalogue publishes no
 * value yet (brief #154, decision 2), so no content depends on a setting, and every combination
 * must write the same bytes, once each publish's random photo paths are set aside. The item that
 * first publishes a value replaces that check with its own expectations. A public column is filled
 * with the same value in every combination for that reason.
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
 * named in `FIXED_PRIVATE` with the reason it needs none: today `parts_import.file_format` and
 * `parts_lot.lot_condition` (#161), which take their first value, like a boolean. A value as
 * short as `N` would be no needle anyway. A third such column fails until someone decides. The parts tables are filled like any other (#161): the import's
 * total value and every lot's unit price are canaries. `photo.parts_lot` stays false in the
 * canary row, because a photo belongs to an item or to the parts lot, never both, and the canary
 * row's photo names its item; its keys are canaries either way.
 */

const tables = Object.values(schema) as PgTable[];

/** Every combination of the three settings: booleans, and each display choice, none and a canary. */
const SHOW_VALUES = [false, true];
const SELLING_MODE = [false, true];
const VALUE_DISPLAYS = [null, 'market', 'asking', 'both', 'canary'] as const;
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
  ['parts_lot.lot_condition', 'a lot is N or U, too short to be a needle; every other lot column is a canary'],
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
      return { value: column.columnType === 'PgNumericNumber' ? Number(value) : value, needles: [String(whole)] };
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
      if (case_.display !== 'canary') row.sellingValueDisplay = case_.display;
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
    version,
    createdAt,
    updatedAt,
  });
  return [storageLocation, String(version), ...[createdAt, updatedAt].flatMap((date) => [date.toISOString(), String(date.getTime()), date.toISOString().slice(0, 19)])];
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
const MATRIX_TIMEOUT_MS = 30_000;

describe('the generated snapshot', () => {
  it('[PUB-4] holds no private field’s value, for every setting, in any file, in any encoding', { timeout: MATRIX_TIMEOUT_MS }, async () => {
    const outputs = new Set<string>();
    for (const case_ of matrix) {
      const { needles, token: stored } = await fillWithCanaries(case_);
      const { publish, store } = publisher(fresh.db, { now: () => new Date('2026-11-01T12:00:00.000Z') });
      await storePhotos(store);
      const result = await publish(anAdmin(), {});
      expect(result.status, JSON.stringify(case_)).toBe('published');

      const [settings] = await fresh.db.select().from(schema.catalogueSettings);
      const token = settings?.publicToken ?? '';
      if (stored !== null) expect(token).toBe(stored);
      // The token, whether stored or just made, is a private value too: never inside a file.
      const all = [...needles, token];
      expect(store.objects.size).toBeGreaterThan(0);
      for (const [key, object] of store.objects) {
        expect(key.startsWith(`c/${token}/`), key).toBe(true);
        const text = [object.contentType, object.cacheControl, Buffer.from(object.body).toString('latin1')].join('\n');
        for (const needle of all) {
          for (const encoded of encodings(needle)) expect(text.includes(encoded), `${key} holds ${needle} (${JSON.stringify(case_)})`).toBe(false);
        }
      }
      // The canary item is published with its photo, both sizes copied, so the scan covered them;
      // and the bulk lot after it, with the fields only a non-set has (#202).
      const catalogue = JSON.parse(Buffer.from(store.objects.get(`c/${token}/catalogue.json`)?.body ?? []).toString()) as {
        items: { kind: string; photos: unknown[]; name: string; refNo: string | null; approxParts: number | null; approxWeightG: number | null; setNum: string | null }[];
        parts: { lots: number; quantity: number; photos: unknown[] } | null;
      };
      expect(catalogue.items).toHaveLength(2);
      expect(catalogue.items[0]).toMatchObject({ kind: 'SET' });
      expect(catalogue.items[0]?.photos).toHaveLength(1);
      expect(catalogue.items[1]).toMatchObject({ kind: 'BULK', setNum: null, name: 'public bulk lot name', refNo: 'public-bulk-ref', approxParts: 2, approxWeightG: 3, photos: [] });
      // [PUB-14] The parts summary: the import's two counts and the overview photo, nothing else.
      const [parts] = await fresh.db.select({ lots: schema.partsImport.lots, quantity: schema.partsImport.quantity }).from(schema.partsImport);
      expect(catalogue.parts).toEqual({ lots: parts?.lots, quantity: parts?.quantity, photos: [expect.any(Object)] });
      expect(Object.keys(catalogue.parts ?? {}).sort()).toEqual(['lots', 'photos', 'quantity']);
      // [PUB-13] The item's photo and the parts lot's, both sizes each, copied.
      expect(store.copied).toHaveLength(4);
      outputs.add(JSON.stringify(store.snapshot()).replaceAll(token, '{token}').replace(/p\/[A-Za-z0-9_-]{43}\.webp/g, 'p/{photo}.webp'));
    }
    // Every combination wrote the same bytes: nothing in the snapshot depends on a setting yet.
    expect(outputs.size).toBe(1);
  });

  it('[PUB-4] [PUB-14] holds no unit price, total value, lot field, item number or colour of the parts', async () => {
    const { needles } = await fillWithCanaries({ showValues: true, sellingMode: true, display: 'both', token: 'made on publish' });
    const [lot] = await fresh.db.select().from(schema.partsLot);
    const [parts] = await fresh.db.select().from(schema.partsImport);
    // Each of them is a canary the matrix above scans every file for, in every encoding.
    const whole = (value: unknown) => String(Math.trunc(Number(value)));
    for (const value of [lot?.itemNo, lot?.itemType, whole(lot?.colorId), whole(lot?.lotQuantity), whole(lot?.unitPrice), whole(parts?.totalValue), parts?.currency, lot?.id, lot?.importId]) {
      expect(needles, String(value)).toContain(value);
    }
    const { publish, store } = publisher(fresh.db);
    await storePhotos(store);
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'published' });
    const json = [...store.objects].find(([key]) => key.endsWith('catalogue.json'))?.[1];
    const catalogue = JSON.parse(Buffer.from(json?.body ?? []).toString()) as { parts: Record<string, unknown> };
    // The summary carries the counts and the photos, and no field of a lot.
    expect(Object.keys(catalogue.parts).sort()).toEqual(['lots', 'photos', 'quantity']);
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

  it('[PUB-4] names no private column, in either case, as a key of its JSON', async () => {
    const { publish, store } = publisher(fresh.db);
    await fillWithCanaries({ showValues: true, sellingMode: true, display: 'both', token: 'made on publish' });
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
    for (const key of keys) expect(privateNames, key).not.toContain(key);
  });

  it('[PUB-4] covers every table of the schema and every private column with a canary', async () => {
    const { needles } = await fillWithCanaries({ showValues: false, sellingMode: false, display: 'canary', token: 'made on publish' });
    const privateNonBoolean = tables.flatMap((table) => {
      const config = getTableConfig(table);
      return config.columns.filter(
        (column) =>
          CLASSIFICATION[config.name]?.[column.name]?.visibility === 'private' &&
          column.columnType !== 'PgBoolean' &&
          !FIXED_PRIVATE.has(`${config.name}.${column.name}`),
      );
    });
    // At least one needle per private column, booleans and the named fixed-value columns aside.
    expect([...FIXED_PRIVATE.keys()].every((name) => tables.some((table) => getTableConfig(table).name === name.split('.')[0]))).toBe(true);
    for (const name of ['parts_import', 'parts_lot']) expect(tables.map((table) => getTableConfig(table).name)).toContain(name);
    expect(needles.length).toBeGreaterThanOrEqual(privateNonBoolean.length);
    expect(matrix).toHaveLength(SHOW_VALUES.length * SELLING_MODE.length * VALUE_DISPLAYS.length * TOKENS.length);
  });
});
