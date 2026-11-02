import { randomBytes, randomInt, randomUUID } from 'node:crypto';
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
 * A foreign key holds the canary of the column it references, so the row it points to is there;
 * a key that points to a table not yet filled is set once that table is (#133).
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

/** A value nothing else in the run could hold, of the column's type, and the strings that find it. */
function canaryFor(table: string, column: PgColumn, index: number): { value: unknown; needles: string[] } {
  const marker = `canary-${table}-${column.name}-${randomBytes(6).toString('hex')}`;
  switch (column.columnType) {
    case 'PgText':
    case 'PgVarchar':
      return { value: marker, needles: [marker] };
    case 'PgUUID': {
      const uuid = randomUUID();
      return { value: uuid, needles: [uuid, uuid.replaceAll('-', '')] };
    }
    case 'PgTimestamp': {
      // A different made-up instant per column, years from anything the clock produces.
      const date = new Date(Date.UTC(1971, 2, 3, 4, 5, 6, 7 + index));
      return { value: date, needles: [date.toISOString(), String(date.getTime()), date.toISOString().slice(0, 19)] };
    }
    case 'PgInteger': {
      // Ten digits, inside PostgreSQL's integer, which nothing else in a snapshot could hold.
      const number = 1_000_000_000 + randomInt(1_000_000_000);
      return { value: number, needles: [String(number)] };
    }
    case 'PgBoolean':
      return { value: true, needles: [] };
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

interface ForeignKey {
  readonly column: PgColumn;
  readonly referencedTable: string;
  readonly referencedColumn: string;
}

/** Each of a table's columns that references another, with the table and column it references. */
function foreignKeys(table: PgTable): Map<string, ForeignKey> {
  const keys = new Map<string, ForeignKey>();
  for (const key of getTableConfig(table).foreignKeys) {
    const reference = key.reference();
    reference.columns.forEach((column, index) => {
      const foreign = reference.foreignColumns[index];
      if (foreign === undefined) throw new Error(`a foreign key of ${getTableConfig(table).name} names no column for ${column.name}`);
      keys.set(column.name, { column, referencedTable: getTableConfig(reference.foreignTable).name, referencedColumn: foreign.name });
    });
  }
  return keys;
}

/** Empties every table and fills one row of each with canaries; returns the needles of the private ones. */
async function fillWithCanaries(case_: Matrix): Promise<{ needles: string[]; token: string | null }> {
  const needles: string[] = [];
  let token: string | null = null;
  await fresh.client.query(`truncate ${tables.map((table) => `"${getTableConfig(table).name}"`).join(', ')}`);

  // Every column's canary first, then each foreign key takes the canary of the column it references.
  const canaries = new Map<string, Map<string, { value: unknown; needles: string[] }>>();
  for (const table of tables) {
    const config = getTableConfig(table);
    canaries.set(config.name, new Map(config.columns.map((column, index) => [column.name, canaryFor(config.name, column, index)])));
  }
  const canary = (table: string, column: string): { value: unknown; needles: string[] } => {
    const found = canaries.get(table)?.get(column);
    if (found === undefined) throw new Error(`no canary for ${table}.${column}`);
    const owner = tables.find((candidate) => getTableConfig(candidate).name === table);
    const key = owner === undefined ? undefined : foreignKeys(owner).get(column);
    return key === undefined ? found : canary(key.referencedTable, key.referencedColumn);
  };

  // A table is filled once every table its required keys reference is; a key that may be null and
  // references a table not yet filled is set after every table is.
  const filled = new Set<string>();
  const later: { table: string; column: string; value: unknown }[] = [];
  const pending = [...tables];
  while (pending.length > 0) {
    const next = pending.findIndex((table) =>
      [...foreignKeys(table).values()].every((key) => filled.has(key.referencedTable) || !key.column.notNull),
    );
    if (next === -1) throw new Error('the foreign keys make a cycle of required columns: teach fillWithCanaries to fill it');
    const [table] = pending.splice(next, 1) as [PgTable];
    const config = getTableConfig(table);
    const keys = foreignKeys(table);
    const row: Record<string, unknown> = {};
    for (const column of config.columns) {
      const { value, needles: found } = canary(config.name, column.name);
      const key = Object.entries(table).find(([, candidate]) => candidate === column)?.[0];
      if (key === undefined) throw new Error(`no property of ${config.name} holds ${column.name}`);
      const reference = keys.get(column.name);
      if (reference !== undefined && !filled.has(reference.referencedTable)) later.push({ table: config.name, column: column.name, value });
      else row[key] = value;
      const visibility = CLASSIFICATION[config.name]?.[column.name]?.visibility;
      if (visibility === undefined) throw new Error(`${config.name}.${column.name} has no classification ([PUB-3])`);
      if (visibility === 'private') needles.push(...found);
    }
    if (config.name === 'catalogue_settings') {
      row.showValues = case_.showValues;
      row.sellingMode = case_.sellingMode;
      if (case_.display !== 'canary') row.sellingValueDisplay = case_.display;
      // The token is the snapshot's address: it may be the path, never content in a file.
      token = case_.token === 'already stored' ? generateCatalogueToken() : null;
      row.publicToken = token;
    }
    await fresh.db.insert(table).values(row);
    filled.add(config.name);
  }
  for (const { table, column, value } of later) await fresh.client.query(`update "${table}" set "${column}" = $1`, [value]);
  return { needles, token };
}

describe('the generated snapshot', () => {
  it('[PUB-4] holds no private field’s value, for every setting, in any file, in any encoding', async () => {
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
        (column) => CLASSIFICATION[config.name]?.[column.name]?.visibility === 'private' && column.columnType !== 'PgBoolean',
      );
    });
    // At least one needle per private column that can hold a canary, booleans aside.
    expect(needles.length).toBeGreaterThanOrEqual(privateNonBoolean.length);
    expect(matrix).toHaveLength(SHOW_VALUES.length * SELLING_MODE.length * VALUE_DISPLAYS.length * TOKENS.length);
  });
});
