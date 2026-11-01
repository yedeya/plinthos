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

/** Empties every table and fills one row of each with canaries; returns the needles of the private ones. */
async function fillWithCanaries(case_: Matrix): Promise<{ needles: string[]; token: string | null }> {
  const needles: string[] = [];
  let token: string | null = null;
  for (const table of tables) {
    const config = getTableConfig(table);
    await fresh.client.query(`delete from "${config.name}"`);
    const row: Record<string, unknown> = {};
    config.columns.forEach((column, index) => {
      const { value, needles: found } = canaryFor(config.name, column, index);
      const key = Object.entries(table).find(([, candidate]) => candidate === column)?.[0];
      if (key === undefined) throw new Error(`no property of ${config.name} holds ${column.name}`);
      row[key] = value;
      const visibility = CLASSIFICATION[config.name]?.[column.name]?.visibility;
      if (visibility === undefined) throw new Error(`${config.name}.${column.name} has no classification ([PUB-3])`);
      if (visibility === 'private') needles.push(...found);
    });
    if (config.name === 'catalogue_settings') {
      row.showValues = case_.showValues;
      row.sellingMode = case_.sellingMode;
      if (case_.display !== 'canary') row.sellingValueDisplay = case_.display;
      // The token is the snapshot's address: it may be the path, never content in a file.
      token = case_.token === 'already stored' ? generateCatalogueToken() : null;
      row.publicToken = token;
    }
    await fresh.db.insert(table).values(row);
  }
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
