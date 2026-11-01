import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { CLASSIFICATION, type Classification } from '../../src/db/schema/classification';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';

/**
 * `[PUB-3]`: every column is classified public or private in one registry. `docs/qa/stack.md`'s
 * `## Data isolation` holds this file: a change that lets an unclassified column through, or that
 * makes a value or a price public, is a regression the Reviewer requests changes on.
 */

const tables = Object.values(schema) as PgTable[];

/** `table.column` for every column, from the schema or from the migrated database. */
function schemaColumns(): string[] {
  return tables.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  });
}

function registry(): [string, Classification][] {
  return Object.entries(CLASSIFICATION).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, classification]): [string, Classification] => [`${table}.${column}`, classification]),
  );
}

// A column whose name says it holds a value, a price or a cost, an amount of money in any form.
const MONEY = /(?:^|_)(?:values?|prices?|costs?|amounts?|asking|paid|purchase)(?:_|$)/;

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});

describe('the public/private registry', () => {
  it('[PUB-3] classifies every column of the Drizzle schema, and nothing that is not one', () => {
    const classified = registry().map(([name]) => name).sort();
    expect(classified).toEqual(schemaColumns().sort());
  });

  it('[PUB-3] classifies every column the migrated database holds, so a column added by hand in SQL fails too', async () => {
    const { rows } = await fresh.client.query<{ name: string }>(
      `select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'`,
    );
    const classified = new Set(registry().map(([name]) => name));
    for (const { name } of rows) expect(classified.has(name), `${name} has no classification`).toBe(true);
    expect(rows.length).toBe(classified.size);
  });

  it('[PUB-3] gives each column exactly public or private, with a reason', () => {
    for (const [name, { visibility, reason }] of registry()) {
      expect(['public', 'private'], name).toContain(visibility);
      expect(reason.trim(), name).not.toBe('');
    }
  });

  it('[PUB-3] classifies every value and asking price private: the settings, not the registry, decide what buyers see', () => {
    const money = registry().filter(([name]) => MONEY.test(name.split('.')[1] ?? ''));
    for (const [name, { visibility }] of money) expect(visibility, name).toBe('private');
    // The pattern does match money, so the rule above is not vacuous for the columns to come.
    for (const column of ['estimated_value', 'asking_price', 'purchase_price', 'value']) expect(column).toMatch(MONEY);
  });

  it('[PUB-3] classifies the catalogue token private: it addresses the snapshot and is never written inside it', () => {
    expect(CLASSIFICATION.catalogue_settings?.public_token?.visibility).toBe('private');
  });

  it('[PUB-3] [PUB-4] keeps the three settings private: the snapshot needs none of them, only their effect (#19)', () => {
    for (const column of ['show_values', 'selling_mode', 'selling_value_display']) {
      expect(CLASSIFICATION.catalogue_settings?.[column]?.visibility, column).toBe('private');
    }
  });
});
