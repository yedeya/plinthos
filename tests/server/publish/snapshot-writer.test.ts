import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as projectionModule from '../../../src/server/publish/projection';
import { NotAPublicProjectionError, readPublication, type PublicProjection } from '../../../src/server/publish/projection';
import { renderSnapshot, writeSnapshot } from '../../../src/server/publish/snapshot';
import { generateCatalogueToken } from '../../../src/server/publish/token';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { readRepoFile, repoRoot } from '../../support/repo-file';
import { MemoryStore } from './fakes';

/**
 * `[PUB-5]`: the snapshot writer accepts only the public projection, and the publish step reads
 * the database only through the one function that builds it. `[PUB-2]`: the page itself says
 * `noindex` too, beside the distribution's header.
 */

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});

const now = new Date('2026-11-01T12:00:00.000Z');
const lookalike = {
  catalogue: { format: 3, publishedAt: now.toISOString(), introText: '', contactText: '', items: [], parts: null },
  photoCopies: [],
};

/**
 * The imports through which a module could reach the database: the schema (`src/db/`), Drizzle,
 * and the service core's `db()` (`src/server/transaction.ts`) and `database()`
 * (`src/server/database.ts`), from any depth. Answers the ones the source holds.
 */
function readsTheDatabase(source: string): string[] {
  const patterns = [
    /from\s+['"][^'"]*\/db\/[^'"]*['"]/g,
    /from\s+['"]drizzle-orm[^'"]*['"]/g,
    /from\s+['"](?:\.\.?\/)+(?:server\/)?(?:transaction|database)['"]/g,
    /import\(\s*['"][^'"]*(?:\/db\/|drizzle-orm|\/transaction|\/database)[^'"]*['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => source.match(pattern) ?? []);
}

describe('the database-import matcher', () => {
  it('[PUB-5] finds every way into the database a module under src/server/publish/ could import, at any depth', () => {
    for (const line of [
      "import { db } from '../transaction';",
      "import { db } from '../../transaction';",
      "import { database } from '../database';",
      "import { database } from '../../../server/database';",
      "import { photo } from '../../../db/schema/photo';",
      "import { eq } from 'drizzle-orm';",
      "import { pgTable } from 'drizzle-orm/pg-core';",
      "const { db } = await import('../../transaction');",
    ]) {
      expect(readsTheDatabase(line), line).not.toEqual([]);
    }
    for (const line of ["import type { CataloguePage } from '../catalogue-data';", "import { STORED_KEY } from '../photos/keys';", "import { z } from 'zod';"]) {
      expect(readsTheDatabase(line), line).toEqual([]);
    }
  });
});

describe('the snapshot writer', () => {
  it('[PUB-5] refuses, at run time, an object shaped like the projection that readPublication did not make', async () => {
    const store = new MemoryStore();
    const token = generateCatalogueToken();
    await expect(writeSnapshot(store, token, lookalike as unknown as PublicProjection)).rejects.toThrow(NotAPublicProjectionError);
    expect(() => renderSnapshot(lookalike as unknown as PublicProjection)).toThrow(NotAPublicProjectionError);
    expect(store.objects.size).toBe(0);
  });

  it('[PUB-5] refuses, at compile time, anything but the projection’s type', async () => {
    const store = new MemoryStore();
    const token = generateCatalogueToken();
    // @ts-expect-error -- a plain object is not a PublicProjection, whatever its fields
    await expect(writeSnapshot(store, token, lookalike)).rejects.toThrow(NotAPublicProjectionError);
    // @ts-expect-error -- a bare string is not a CatalogueToken
    await expect(writeSnapshot(store, 'not-a-token', lookalike)).rejects.toThrow();
  });

  it('[PUB-5] writes what readPublication made, and a copy of it is refused', async () => {
    const { token, projection, release } = await readPublication(fresh.db, { now: () => now });
    await release();
    const store = new MemoryStore();
    await writeSnapshot(store, token, projection);
    // Every file the renderers make, whatever they are (#163 adds a stylesheet and a script).
    expect(store.objects.size).toBe(renderSnapshot(projection).length);
    expect(store.objects.size).toBeGreaterThanOrEqual(3);
    expect(() => renderSnapshot({ ...projection })).toThrow(NotAPublicProjectionError);
    expect(Object.isFrozen(projection) && Object.isFrozen(projection.catalogue)).toBe(true);
  });

  it('[PUB-5] the publish step reaches the database only through readPublication', () => {
    const directory = join(repoRoot, 'src/server/publish');
    // Every module under the folder, at any depth: the page renderers live in `pages/` (#163).
    const files = readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .map((file) => file.split(sep).join('/'))
      .filter((file) => file.endsWith('.ts'));
    expect(files).toContain('projection.ts');
    expect(files).toContain('pages/index.ts');
    // Only the projection imports the schema, Drizzle or the service core's ways into the database.
    // One exception: `publish.ts` wires the deployed `database` in, and the check below holds it
    // to handing that to readPublication alone.
    for (const file of files.filter((name) => name !== 'projection.ts')) {
      const found = readsTheDatabase(readRepoFile(`src/server/publish/${file}`));
      expect(found, file).toEqual(file === 'publish.ts' ? ["from '../database'"] : []);
    }
    // The publish step hands its database to readPublication and to nothing else.
    const publish = readRepoFile('src/server/publish/publish.ts');
    const uses = publish.match(/dependencies\.database\(\)/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(publish).toContain('readPublication(dependencies.database(),');
    // And the projection module offers one function that reads the database.
    const functions = Object.entries(projectionModule)
      .filter(([, value]) => typeof value === 'function' && !/^[A-Z]/.test(value.name))
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(['assertPublicProjection', 'readPublication']);
  });
});

describe('the pages of a snapshot', () => {
  it('[PUB-2] each says noindex and sends no referrer', async () => {
    const { projection, release } = await readPublication(fresh.db, { now: () => now });
    await release();
    const pages = renderSnapshot(projection).filter(({ object }) => object.contentType.startsWith('text/html'));
    expect(pages.length).toBeGreaterThan(0);
    for (const { name, object } of pages) {
      const page = Buffer.from(object.body).toString();
      expect(page, name).toMatch(/<meta name="robots" content="noindex[^"]*">/);
      expect(page, name).toContain('<meta name="referrer" content="no-referrer">');
    }
  });
});
