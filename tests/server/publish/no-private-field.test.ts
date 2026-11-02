import { randomBytes, randomUUID } from 'node:crypto';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { CLASSIFICATION } from '../../../src/db/schema/classification';
import { generateCatalogueToken } from '../../../src/server/publish/token';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { anAdmin, publisher } from './fakes';

/**
 * `[PUB-4]`: no private field's value appears anywhere in a generated snapshot. Every private
 * column of every table in the schema is filled with a canary, a value made for this run that
 * nothing else could produce, and every byte of every file the publish step writes is scanned for
 * each canary, as it is and in the encodings a page could carry it in. This runs for every
 * combination of `show_values`, `selling_mode` and `selling_value_display`, with the token made
 * on the publish and with one already stored.
 *
 * A boolean can't be a canary, so the switches are held a second way: the walking skeleton's
 * snapshot has no content a setting applies to, so every combination must write the same bytes.
 * The content item that first publishes a value replaces that check with its own expectations.
 *
 * `docs/qa/stack.md`'s `## Data isolation` holds this file. A new table needs nothing here; a
 * column of a type this test can't fill fails it, and the fix is to teach `canaryFor` the type.
 * A foreign key is filled with the canary of the row it names, and a table is filled after the
 * tables its required keys name; a nullable key into a table not filled yet is set once every
 * table is (`photo.item_id` and `collection_item.cover_photo_id` name each other, #124).
 *
 * A private text column with fixed values (`parts_import.format`, `parts_lot.condition`, #161)
 * can't hold a canary either: it takes its first value, like a boolean, and a value as short as
 * `N` would be no needle anyway. The parts tables are filled like any other (#161): the import's
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
function canaryFor(table: string, column: PgColumn, index: number, visibility: 'public' | 'private'): { value: unknown; needles: string[] } {
  const marker = `canary-${table}-${column.name}-${randomBytes(6).toString('hex')}`;
  const fixed = (column as { enumValues?: readonly string[] }).enumValues;
  switch (column.columnType) {
    case 'PgText':
    case 'PgVarchar':
      if (fixed !== undefined && fixed.length > 0) return { value: fixed[0], needles: [] };
      return { value: marker, needles: [marker] };
    case 'PgInteger': {
      if (visibility === 'public') return { value: 1 + index, needles: [] };
      // Nine digits that start with 7 and nothing else in the run produces.
      const value = 700_000_000 + randomBytes(3).readUIntBE(0, 3) * 10 + (index % 10);
      return { value, needles: [String(value)] };
    }
    case 'PgUUID': {
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

/** The tables in an order that fills each after the tables its required foreign keys name. */
function fillOrder(): PgTable[] {
  const order: PgTable[] = [];
  const pending = [...tables];
  while (pending.length > 0) {
    const next = pending.findIndex((table) =>
      getTableConfig(table)
        .foreignKeys.map((key) => key.reference())
        .every((reference) => reference.columns.every((column) => !column.notNull) || order.includes(reference.foreignTable)),
    );
    if (next === -1) throw new Error('the required foreign keys form a cycle: teach fillOrder in this test to break it');
    order.push(...pending.splice(next, 1));
  }
  return order;
}

/**
 * Empties every table, in one round trip: the nullable keys first, which may name each other, then
 * each table before the tables its required keys name. A `truncate` of every table took most of a
 * combination's time (#140), and deleting the one row each holds does the same work.
 */
function emptyEveryTable(): string {
  const nullable = tables.flatMap((table) => {
    const config = getTableConfig(table);
    const columns = config.foreignKeys.flatMap((key) => key.reference().columns.filter((column) => !column.notNull));
    return columns.length === 0 ? [] : [`update "${config.name}" set ${columns.map((column) => `"${column.name}" = null`).join(', ')}`];
  });
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
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      if (filled.includes(reference.foreignTable)) continue;
      for (const column of reference.columns) {
        deferred[keyOf(table, column)] = row[keyOf(table, column)];
        row[keyOf(table, column)] = null;
      }
    }
    await fresh.db.insert(table).values(row);
    filled.push(table);
    if (Object.keys(deferred).length > 0) later.push(() => fresh.db.update(table).set(deferred));
  }
  for (const update of later) await update();
  return { needles, token };
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
      outputs.add(JSON.stringify(store.snapshot()).replaceAll(token, '{token}'));
    }
    // Every combination wrote the same bytes: nothing in the snapshot depends on a setting yet.
    expect(outputs.size).toBe(1);
  });

  it('[PUB-4] names no private column, in either case, as a key of its JSON', async () => {
    const { publish, store } = publisher(fresh.db);
    await fillWithCanaries({ showValues: true, sellingMode: true, display: 'both', token: 'made on publish' });
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
    const privateNames = Object.values(CLASSIFICATION).flatMap((columns) =>
      Object.entries(columns)
        .filter(([, { visibility }]) => visibility === 'private')
        .flatMap(([name]) => [name, camel(name)]),
    );
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
          ((column as { enumValues?: readonly string[] }).enumValues ?? []).length === 0,
      );
    });
    // At least one needle per private column that can hold a canary, booleans and fixed values aside.
    for (const name of ['parts_import', 'parts_lot']) expect(tables.map((table) => getTableConfig(table).name)).toContain(name);
    expect(needles.length).toBeGreaterThanOrEqual(privateNonBoolean.length);
    expect(matrix).toHaveLength(SHOW_VALUES.length * SELLING_MODE.length * VALUE_DISPLAYS.length * TOKENS.length);
  });
});
