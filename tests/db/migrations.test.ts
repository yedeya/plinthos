import { spawnSync } from 'node:child_process';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { CATALOGUE_SETTINGS_ID } from '../../src/db/schema/catalogue-settings';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';
import { repoRoot } from '../support/repo-file';

const tables = Object.values(schema) as PgTable[];

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
});
afterAll(async () => {
  await fresh.drop();
});

interface Column {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_identity: 'YES' | 'NO';
}

/** Every column of the application's tables, as the migrated database holds them. */
async function databaseColumns(): Promise<Column[]> {
  const { rows } = await fresh.client.query<Column>(
    // A numeric column with a precision reads as Drizzle writes its type, numeric(p, s) (#161).
    `select table_name, column_name,
            case when data_type = 'numeric' and numeric_precision is not null
                 then 'numeric(' || numeric_precision || ', ' || numeric_scale || ')' else data_type end as data_type,
            is_nullable, column_default, is_identity
       from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`,
  );
  return rows;
}

/** Runs the schema check CI runs, against the given schema module. */
function schemaCheck(schemaPath?: string) {
  const result = spawnSync('npx', ['tsx', 'scripts/schema-check.ts', ...(schemaPath === undefined ? [] : [schemaPath])], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the migrations', () => {
  it('[PLAT-12] apply every pending migration, and a second run applies none', async () => {
    const first = await applyMigrations(fresh.db, fresh.migrate);
    expect(first.applied).toBeGreaterThan(0);
    expect(first.total).toBe(first.applied);
    const second = await applyMigrations(fresh.db, fresh.migrate);
    expect(second).toEqual({ applied: 0, total: first.total });
  });

  it('[PLAT-11] build exactly the tables and columns the Drizzle schema declares', async () => {
    await applyMigrations(fresh.db, fresh.migrate);
    const expected = tables
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns.map((column) => ({
          table_name: config.name,
          column_name: column.name,
          data_type: column.getSQLType(),
          is_nullable: column.notNull ? 'NO' : 'YES',
        }));
      })
      .sort((a, b) => `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`));
    const actual = (await databaseColumns())
      .map(({ table_name, column_name, data_type, is_nullable }) => ({ table_name, column_name, data_type, is_nullable }))
      .sort((a, b) => `${a.table_name}.${a.column_name}`.localeCompare(`${b.table_name}.${b.column_name}`));
    expect(actual).toEqual(expected);
  });

  it('[PLAT-11] the schema check passes on the committed schema, and fails on a schema change with no migration', () => {
    const passes = schemaCheck();
    expect(passes.status, passes.output).toBe(0);
    const fails = schemaCheck('./tests/db/fixtures/schema-with-an-unmigrated-column.ts');
    expect(fails.status, fails.output).toBe(1);
    expect(fails.output).toMatch(/the schema holds changes no committed migration does/);
    expect(fails.output).toContain('npm run db:generate');
  }, 120_000);

  it('[PLAT-13] every table’s primary key is one UUID column, which the application generates', async () => {
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const config = getTableConfig(table);
      const keys = config.columns.filter((column) => column.primary);
      expect(keys.map((column) => column.getSQLType()), config.name).toEqual(['uuid']);
      expect(config.primaryKeys, config.name).toEqual([]);
      const [key] = keys;
      expect(key?.defaultFn, `${config.name}: the application makes its key`).toBeTypeOf('function');
      expect(key?.hasDefault && key.default !== undefined, `${config.name}: no database default for its key`).toBe(false);
    }
  });

  it('[PLAT-13] the migrated database has no sequence, identity or serial column, and no key the database makes', async () => {
    await applyMigrations(fresh.db, fresh.migrate);
    const sequences = await fresh.client.query(`select sequence_name from information_schema.sequences where sequence_schema = 'public'`);
    expect(sequences.rows).toEqual([]);
    for (const column of await databaseColumns()) {
      expect(column.is_identity, `${column.table_name}.${column.column_name}`).toBe('NO');
      expect(column.column_default ?? '', `${column.table_name}.${column.column_name}`).not.toMatch(/nextval|gen_random_uuid|uuid_generate/);
    }
    const { rows } = await fresh.client.query<{ table_name: string; data_type: string }>(
      `select c.table_name, c.data_type
         from information_schema.table_constraints t
         join information_schema.key_column_usage k using (constraint_schema, constraint_name)
         join information_schema.columns c on c.table_schema = k.table_schema and c.table_name = k.table_name and c.column_name = k.column_name
        where t.constraint_type = 'PRIMARY KEY' and t.table_schema = 'public'`,
    );
    expect(rows.map(({ table_name }) => table_name).sort()).toEqual(tables.map((table) => getTableConfig(table).name).sort());
    for (const row of rows) expect(row.data_type, row.table_name).toBe('uuid');
  });

  it('create the catalogue_settings singleton: values hidden, selling mode off, no token and no value display yet', async () => {
    await applyMigrations(fresh.db, fresh.migrate);
    const rows = await fresh.db.select().from(schema.catalogueSettings);
    expect(rows).toEqual([
      {
        id: CATALOGUE_SETTINGS_ID,
        publicToken: null,
        showValues: false,
        sellingMode: false,
        sellingValueDisplay: null,
        publishLease: null,
        publishLeaseUntil: null,
      },
    ]);
    await expect(fresh.db.insert(schema.catalogueSettings).values({})).rejects.toThrow();
    expect(await fresh.db.select().from(schema.catalogueSettings)).toHaveLength(1);
  });
});
