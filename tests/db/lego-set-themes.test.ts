import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';
import { repoRoot } from '../support/repo-file';

/**
 * A set stored before the migration that adds its theme id and top-level theme (#258, [ITEM-11])
 * reads null in both until the backfill fills them ([ITEM-13]). `tests/db/migrations.test.ts` checks
 * the columns and the migration's statements, and `tests/db/classification.test.ts` their
 * classification; this file stores a row under the schema from before the migration. Every set here
 * is made up.
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
async function themesMigration(): Promise<JournalEntry> {
  for (const entry of (await journal(folder)).entries) {
    if ((await readFile(path.join(folder, `${entry.tag}.sql`), 'utf8')).includes('"top_theme"')) return entry;
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
  const themes = await themesMigration();
  const trimmed = await journal(before);
  trimmed.entries = trimmed.entries.filter((each) => each.idx < themes.idx);
  await writeFile(path.join(before, 'meta', '_journal.json'), JSON.stringify(trimmed));
});
afterAll(async () => {
  await fresh.drop();
  await rm(before, { recursive: true, force: true });
});

describe('a set’s theme id and top-level theme', () => {
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
});
