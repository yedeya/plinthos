import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as projectionModule from '../../../src/server/publish/projection';
import { NotAPublicProjectionError, readPublication, type PublicProjection } from '../../../src/server/publish/projection';
import { renderPlaceholderPage, renderSnapshot, writeSnapshot } from '../../../src/server/publish/snapshot';
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
const lookalike = { catalogue: { format: 1, status: 'placeholder', publishedAt: now.toISOString() } };

describe('the snapshot writer', () => {
  it('[PUB-5] refuses, at run time, an object shaped like the projection that readPublication did not make', async () => {
    const store = new MemoryStore();
    const token = generateCatalogueToken();
    await expect(writeSnapshot(store, token, lookalike as unknown as PublicProjection)).rejects.toThrow(NotAPublicProjectionError);
    expect(() => renderSnapshot(lookalike as unknown as PublicProjection)).toThrow(NotAPublicProjectionError);
    expect(() => renderPlaceholderPage({ ...lookalike } as unknown as PublicProjection)).toThrow(NotAPublicProjectionError);
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
    expect(store.objects.size).toBe(3);
    expect(() => renderSnapshot({ ...projection })).toThrow(NotAPublicProjectionError);
    expect(Object.isFrozen(projection) && Object.isFrozen(projection.catalogue)).toBe(true);
  });

  it('[PUB-5] the publish step reaches the database only through readPublication', () => {
    const directory = join(repoRoot, 'src/server/publish');
    const files = readdirSync(directory).filter((file) => file.endsWith('.ts'));
    expect(files).toContain('projection.ts');
    // Only the projection imports the schema or Drizzle.
    for (const file of files.filter((name) => name !== 'projection.ts')) {
      const source = readRepoFile(`src/server/publish/${file}`);
      expect(source, file).not.toMatch(/from '[^']*\/db\//);
      expect(source, file).not.toMatch(/from 'drizzle-orm/);
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

describe('the placeholder page', () => {
  it('[PUB-2] says noindex and sends no referrer, runs no script and loads nothing from anywhere', async () => {
    const { projection, release } = await readPublication(fresh.db, { now: () => now });
    await release();
    const page = renderPlaceholderPage(projection);
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
    expect(page).not.toMatch(/<script|<link|<img|<iframe|https?:|src=|href=/i);
    expect(page).toContain('Nothing is published here yet.');
  });
});
