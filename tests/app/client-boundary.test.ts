import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A server module can render a client module's component, but it can't call the client module's
 * functions: Next.js replaces them with references that throw at request time, a failure no
 * typecheck or unit test sees (#206 shipped one, and `/admin/parts` failed to render). So no
 * module under `src/app` without `'use client'` imports from one with it anything but a
 * component (a PascalCase name) or a type: a constant from one breaks the same way.
 */

const APP = resolve(__dirname, '../../src/app');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const isClient = (source: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** The value names a server module imports from client modules, which it can't call. */
function callableClientImports(): string[] {
  const found: string[] = [];
  for (const file of files(APP)) {
    const source = readFileSync(file, 'utf8');
    if (isClient(source)) continue;
    for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gm)) {
      if (match[1]) continue;
      const target = resolveImport(file, match[3] ?? '');
      if (target === null || !isClient(readFileSync(target, 'utf8'))) continue;
      for (const raw of (match[2] ?? '').split(',')) {
        const name = raw.trim();
        if (name === '' || name.startsWith('type ')) continue;
        const exported = name.split(/\s+as\s+/)[0] ?? name;
        if (!/^[A-Z][a-z]/.test(exported)) found.push(`${file.slice(APP.length + 1)}: ${name} from ${match[3]}`);
      }
    }
  }
  return found;
}

describe('the server and client boundary', () => {
  it('[PARTS-1] no server module calls a function from a client module', () => {
    expect(callableClientImports()).toEqual([]);
  });
});
