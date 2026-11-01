import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dynamic, GET } from '../../src/app/health/live/route';
import { repoRoot } from '../support/repo-file';

const ROUTE = join(repoRoot, 'src/app/health/live/route.ts');

// Anything that reaches a database: the project's database module and every database driver.
const DATABASE = /^(?:pg|pg-.*|postgres|drizzle-orm(?:\/.*)?|@aws-sdk\/client-rds-data|@neondatabase\/.*)$/;

/** Every module `file` imports, transitively for the project's own files, as specifiers and paths. */
function importGraph(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
  return specifiers.flatMap((specifier) => {
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return [specifier];
    const base = specifier.startsWith('@/') ? join(repoRoot, 'src', specifier.slice(2)) : resolve(dirname(file), specifier);
    const path = ['', '.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find((candidate) => existsSync(candidate));
    if (path === undefined) throw new Error(`${relative(repoRoot, file)} imports ${specifier}, which this test cannot resolve`);
    return [relative(repoRoot, path), ...importGraph(path, seen)];
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('/health/live', () => {
  it('[PLAT-14] answers 200 with {"status":"ok"}, uncached', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('[PLAT-14] still answers 200 when the database cannot be reached', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://nobody:nothing@127.0.0.1:1/none');
    expect(GET().status).toBe(200);
    vi.stubEnv('DATABASE_URL', '');
    expect(GET().status).toBe(200);
  });

  it('[PLAT-14] imports neither the database module nor any database driver, directly or through another module', () => {
    const graph = importGraph(ROUTE);
    for (const entry of graph) {
      expect(entry, 'the database module').not.toMatch(/^src\/db\//);
      expect(entry, 'a database driver').not.toMatch(DATABASE);
    }
  });

  it('[PLAT-14] [PLAT-4] runs on every request, so a 200 proves the server function answers', () => {
    expect(dynamic).toBe('force-dynamic');
  });
});
