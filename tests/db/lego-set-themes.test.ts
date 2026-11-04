import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { CLASSIFICATION } from '../../src/db/schema/classification';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';
import { repoRoot } from '../support/repo-file';

/**
 * A set's theme id and top-level theme (#258, [ITEM-11]): two nullable columns on `lego_set`, in a
 * migration that only adds, so a set stored before it reads null until the backfill fills it
 * ([ITEM-13]). Nothing reads or writes them yet. Every set here is made up.
 */

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

const folder = path.join(repoRoot, MIGRATIONS_FOLDER);

async function journal(dir: string): Promise<{ entries: JournalEntry[] } & Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] } & Record<string, unknown>;
}

/** The migration that adds the two columns, found by what it does rather than by its number. */
async function themesMigration(): Promise<{ entry: JournalEntry; sql: string }> {
  for (const entry of (await journal(folder)).entries) {
    const sql = await readFile(path.join(folder, `${entry.tag}.sql`), 'utf8');
    if (sql.includes('"top_theme"')) return { entry, sql };
  }
  throw new Error('no migration adds lego_set.top_theme');
}

let fresh: FreshDatabase;
let before: string;
beforeAll(async () => {
  fresh = await freshDatabase();
  // A copy of `drizzle/` that stops before the themes migration: the schema a deployed set was stored under.
  before = await mkdtemp(path.join(tmpdir(), 'plinthos-migrations-'));
  await cp(folder, before, { recursive: true });
  const { entry } = await themesMigration();
  const trimmed = await journal(before);
  trimmed.entries = trimmed.entries.filter((each) => each.idx < entry.idx);
  await writeFile(path.join(before, 'meta', '_journal.json'), JSON.stringify(trimmed));
});
afterAll(async () => {
  await fresh.drop();
  await rm(before, { recursive: true, force: true });
});

describe('a set’s theme id and top-level theme', () => {
  it('[ITEM-11] adds theme_id, an integer, and top_theme, text, both nullable, in a migration that only adds', async () => {
    const columns = Object.fromEntries(getTableConfig(schema.legoSet).columns.map((column) => [column.name, column]));
    expect(columns.theme_id?.getSQLType()).toBe('integer');
    expect(columns.theme_id?.notNull).toBe(false);
    expect(columns.top_theme?.getSQLType()).toBe('text');
    expect(columns.top_theme?.notNull).toBe(false);

    const { sql } = await themesMigration();
    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    expect(statements.sort()).toEqual([
      'ALTER TABLE "lego_set" ADD COLUMN "theme_id" integer;',
      'ALTER TABLE "lego_set" ADD COLUMN "top_theme" text;',
    ]);
  });

  it('[ITEM-11] leaves a set stored before the migration with a null theme id and top-level theme, and its other fields as they were', async () => {
    await applyMigrations(fresh.db, fresh.migrate, before);
    const id = randomUUID();
    const fetchedAt = new Date('2026-10-01T12:00:00.000Z');
    // The columns the deployed code writes, by name, as it did before the migration.
    await fresh.client.query(
      `insert into lego_set (id, set_num, name, theme, year, num_parts, image_url, fetched_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, '990258-1', 'Made-up dojo', 'Made-up sub-theme', 2019, 512, null, fetchedAt],
    );
    const result = await applyMigrations(fresh.db, fresh.migrate);
    expect(result.applied).toBeGreaterThan(0);
    const rows = await fresh.db.select().from(schema.legoSet).where(eq(schema.legoSet.id, id));
    expect(rows).toEqual([
      { id, setNum: '990258-1', name: 'Made-up dojo', theme: 'Made-up sub-theme', themeId: null, topTheme: null, year: 2019, numParts: 512, imageUrl: null, fetchedAt },
    ]);
  });

  it('[ITEM-11] [PUB-3] classifies theme_id private, an internal key, and top_theme public, a public fact about the set', () => {
    expect(CLASSIFICATION.lego_set?.theme_id?.visibility).toBe('private');
    expect(CLASSIFICATION.lego_set?.theme_id?.reason).toMatch(/internal key/);
    expect(CLASSIFICATION.lego_set?.top_theme?.visibility).toBe('public');
    expect(CLASSIFICATION.lego_set?.top_theme?.reason).toMatch(/public fact about the set/);
  });
});
