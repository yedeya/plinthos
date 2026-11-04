import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
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
  catalogue: { format: 4, publishedAt: now.toISOString(), introText: '', contactText: '', items: [], parts: null },
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

/** Every extension a module of the service core could have: `tsconfig.json` allows JS and JSX (#177). */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * The modules a source imports at run time, by specifier: static imports and re-exports, imports
 * for their side effects, dynamic imports and `require`. An `import type` or `export type` is
 * erased before the code runs, so it is left out. `computed` says a dynamic import or `require`
 * names its module by anything but a string literal, which no scan can follow.
 */
function runtimeImports(source: string): { specifiers: string[]; computed: boolean } {
  const specifiers = [
    ...[...source.matchAll(/\b(?:import|export)\s+(?!type\b)[\w$*{}\s,]+?\s+from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...source.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)].map((match) => match[1]),
  ].filter((specifier): specifier is string => specifier !== undefined);
  const literal = /\b(?:import|require)\s*\(\s*['"`][^'"`$]+['"`]\s*\)/g;
  const computed = (source.match(/\b(?:import|require)\s*\(/g) ?? []).length > (source.match(literal) ?? []).length;
  return { specifiers, computed };
}

/** The repository-relative file a relative specifier names, or undefined when none exists. */
function resolveModule(from: string, specifier: string): string | undefined {
  const base = join(repoRoot, dirname(from), specifier);
  const candidates = [base, ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))];
  // An ESM-style `./x.js` names `./x.ts`.
  if (/\.[cm]?jsx?$/.test(base)) candidates.push(...SOURCE_EXTENSIONS.map((extension) => base.replace(/\.[cm]?jsx?$/, extension)));
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  return found === undefined ? undefined : relative(repoRoot, found).split(sep).join('/');
}

/** The packages through which a module could reach the database on its own: Drizzle and the drivers. */
const DATABASE_PACKAGES = /^(?:drizzle-orm|pg|postgres|@aws-sdk\/client-rds-data)(?:\/|$)/;
/** The service core's ways into the database, and the schema and client under `src/db/`. */
const isDatabaseModule = (file: string) => file === 'src/server/transaction.ts' || file === 'src/server/database.ts' || file.startsWith('src/db/');

/**
 * Follows every run-time import from a module under `src/server/publish/`, through every module
 * it leads to in the repository, and answers each way it reaches the database (#177): a database
 * module or package, a module that can't be resolved, or an import no scan can follow, each with
 * the chain of modules that leads there. `projection.ts` is where publishing may read the
 * database, so the walk does not enter it; `allowed` names direct imports the caller holds apart.
 */
function databaseReaches(start: string, allowed: readonly string[] = []): string[] {
  const reaches: string[] = [];
  const seen = new Set<string>([start]);
  const queue: string[][] = [[start]];
  for (let chain = queue.shift(); chain !== undefined; chain = queue.shift()) {
    const file = chain.at(-1) ?? start;
    const { specifiers, computed } = runtimeImports(readRepoFile(file));
    if (computed) reaches.push(`${chain.join(' → ')} → a computed import`);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        if (DATABASE_PACKAGES.test(specifier)) reaches.push(`${chain.join(' → ')} → ${specifier}`);
        continue;
      }
      const target = resolveModule(file, specifier);
      if (target === undefined) {
        reaches.push(`${chain.join(' → ')} → ${specifier}, which resolves to no file`);
        continue;
      }
      if (target === 'src/server/publish/projection.ts') continue;
      if (chain.length === 1 && allowed.includes(target)) continue;
      if (isDatabaseModule(target)) {
        reaches.push(`${[...chain, target].join(' → ')}`);
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push([...chain, target]);
    }
  }
  return reaches;
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

  it('[PUB-5] follows every run-time import, multi-line, re-exported, dynamic or required, and leaves out the type-only ones (#177)', () => {
    const source = [
      "import { a } from './static';",
      'import {\n  b,\n  type C,\n} from "../multi-line";',
      "import * as d from './namespace';",
      "import e, { f } from './default';",
      "import './side-effect';",
      "export { g } from './re-export';",
      "export * from './star';",
      "const h = await import('./dynamic');",
      'const i = require(`./required`);',
      "import type { J } from './type-only';",
      "export type { K } from './type-re-export';",
    ].join('\n');
    expect(runtimeImports(source)).toEqual({
      specifiers: ['./static', '../multi-line', './namespace', './default', './re-export', './star', './side-effect', './dynamic', './required'],
      computed: false,
    });
    for (const line of ['const l = await import(name);', 'const m = require(`./${name}`);']) expect(runtimeImports(line).computed, line).toBe(true);
  });

  it('[PUB-5] finds the database behind another service module, and a module that resolves to none (#177)', () => {
    // `items.ts` reads the database through `db()`, so a renderer that imported it would reach it.
    expect(databaseReaches('src/server/items/items.ts').some((reach) => reach.endsWith('src/server/transaction.ts'))).toBe(true);
    expect(resolveModule('src/server/publish/pages/index.ts', './landing')).toBe('src/server/publish/pages/landing.ts');
    expect(resolveModule('src/server/publish/pages/index.ts', './landing.js')).toBe('src/server/publish/pages/landing.ts');
    expect(resolveModule('src/server/publish/pages/index.ts', './not-a-module')).toBeUndefined();
    for (const name of ['drizzle-orm', 'drizzle-orm/pg-core', 'pg', '@aws-sdk/client-rds-data']) expect(DATABASE_PACKAGES.test(name), name).toBe(true);
    for (const name of ['zod', 'pino', '@aws-sdk/client-s3', 'pgx-not-a-driver']) expect(DATABASE_PACKAGES.test(name), name).toBe(false);
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
    // Every source file, whatever its extension (#177): a `.tsx` or `.js` module is scanned too.
    const files = readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .map((file) => file.split(sep).join('/'))
      .filter((file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)));
    expect(files).toContain('projection.ts');
    expect(files).toContain('pages/index.ts');
    // Only the projection imports the schema, Drizzle or the service core's ways into the database.
    // One exception: `publish.ts` wires the deployed `database` in, and the check below holds it
    // to handing that to readPublication alone.
    for (const file of files.filter((name) => name !== 'projection.ts')) {
      const found = readsTheDatabase(readRepoFile(`src/server/publish/${file}`));
      expect(found, file).toEqual(file === 'publish.ts' ? ["from '../database'"] : []);
      // Nor does any module it leads to, through another service module at any depth (#177): the
      // walk stops at the projection, and only publish.ts's own import of `database` is set apart.
      const reaches = databaseReaches(`src/server/publish/${file}`, file === 'publish.ts' ? ['src/server/database.ts'] : []);
      expect(reaches, file).toEqual([]);
    }
    // The publish step hands its database to readPublication and to nothing else.
    const publish = readRepoFile('src/server/publish/publish.ts');
    const uses = publish.match(/dependencies\.database\(\)/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(publish).toContain('readPublication(dependencies.database(),');
    // And the projection module offers two functions that read the database, both through its one
    // `project`: `readPublication` for the publish step, and `readCatalogueData` (#236) for the
    // export's buyer preset and the printable summary, which takes no turn and no token and
    // answers the data alone. The publish step never calls the second.
    const functions = Object.entries(projectionModule)
      .filter(([, value]) => typeof value === 'function' && !/^[A-Z]/.test(value.name))
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(['assertPublicProjection', 'readCatalogueData', 'readPublication']);
    expect(publish).not.toContain('readCatalogueData');
    const projection = readRepoFile('src/server/publish/projection.ts');
    // Both readers build from the one `project`, and only readPublication issues what the writer takes.
    expect(projection.match(/await project\(/g)).toHaveLength(2);
    expect(projection.match(/issued\.add\(/g)).toHaveLength(1);
  });

  it('[PUB-5] refuses, as a projection, what readCatalogueData answers for the export (#236)', async () => {
    const data = await projectionModule.readCatalogueData(fresh.db, { now: () => now });
    const store = new MemoryStore();
    expect(Object.keys(data)).not.toContain('photoCopies');
    for (const candidate of [data, { catalogue: data, photoCopies: [] }]) {
      expect(() => renderSnapshot(candidate as unknown as PublicProjection)).toThrow(NotAPublicProjectionError);
      await expect(writeSnapshot(store, generateCatalogueToken(), candidate as unknown as PublicProjection)).rejects.toThrow(NotAPublicProjectionError);
    }
    expect(store.objects.size).toBe(0);
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
