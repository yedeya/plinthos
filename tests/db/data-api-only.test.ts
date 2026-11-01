import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile, repoRoot } from '../support/repo-file';

// Every way to open a TCP connection to PostgreSQL from Node: the drivers, and Drizzle's adapters
// over them. Only tests may use one ([PLAT-9]).
const TCP_DRIVER = /^(?:pg|pg-.+|postgres|drizzle-orm\/(?:node-postgres|postgres-js|pglite|neon-serverless|vercel-postgres)(?:\/.*)?|@neondatabase\/.+|@vercel\/postgres)$/;

/** What deploys or runs against the deployment: the application and the deploy's scripts. */
function deployedSources(): { path: string; source: string }[] {
  return ['src', 'scripts'].flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return { path: relative(repoRoot, path), source: readFileSync(path, 'utf8') };
      }),
  );
}

function imports(source: string): string[] {
  return [...source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
}

describe('deployed code reaches the database only through the Data API', () => {
  it('[PLAT-9] nothing under src/ or scripts/ imports a TCP driver for PostgreSQL', () => {
    const sources = deployedSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const { path, source } of sources) {
      for (const specifier of imports(source)) expect(specifier, path).not.toMatch(TCP_DRIVER);
    }
  });

  it('[PLAT-9] the database module and the migration step use Drizzle’s Data API driver', () => {
    expect(imports(readRepoFile('src/db/client.ts'))).toEqual(
      expect.arrayContaining(['@aws-sdk/client-rds-data', 'drizzle-orm/aws-data-api/pg']),
    );
    expect(imports(readRepoFile('scripts/migrate.ts'))).toContain('drizzle-orm/aws-data-api/pg/migrator');
  });

  it('[PLAT-9] the TCP driver is a development dependency only, so it never ships in the server function', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as Record<'dependencies' | 'devDependencies', Record<string, string>>;
    for (const name of Object.keys(pkg.dependencies)) expect(name, 'a TCP driver in dependencies').not.toMatch(TCP_DRIVER);
    expect(pkg.devDependencies).toHaveProperty('pg');
    expect(pkg.dependencies).toHaveProperty('drizzle-orm');
    expect(pkg.dependencies).toHaveProperty('@aws-sdk/client-rds-data');
  });

  it('[PLAT-9] DATABASE_URL, the TCP connection string, is read only for tests, never by deployed code', () => {
    for (const { path, source } of deployedSources()) {
      if (path === 'src/db/database-url.ts') continue;
      expect(source, path).not.toMatch(/DATABASE_URL/);
      for (const specifier of imports(source)) expect(specifier, path).not.toMatch(/database-url$/);
    }
  });
});
