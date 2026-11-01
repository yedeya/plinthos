import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appRoutes, directivesOf, inlineServerActions, segmentFiles, serverActionModules } from '../support/admin-harness';

/**
 * #59: the finders `tests/app/admin-routes.test.ts` walks catch every form an admin surface can
 * take, shown on a made-up app directory, since the real one holds none of the forms they refuse.
 */

const sandbox = mkdtempSync(join(tmpdir(), 'plinthos-admin-harness-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(sandbox, path)), { recursive: true });
  writeFileSync(join(sandbox, path), text);
}

write('src/app/layout.tsx', 'export default function Layout({ children }) { return children; }\n');
write('src/app/admin/page.tsx', 'export default async function Page() { return null; }\n');
write('src/app/admin/layout.tsx', 'export default async function Layout({ children }) { return children; }\n');
write('src/app/admin/(group)/sets/loading.tsx', 'export default function Loading() { return null; }\n');
write('src/app/admin/error.tsx', "'use client';\nexport default function ErrorPage() { return null; }\n");
write('src/app/admin/notes.tsx', 'export const notes = 1;\n');
write('src/app/admin/icon.tsx', 'export default function Icon() { return null; }\n');
write('src/app/admin/opengraph-image.png', 'not an image\n');
write('src/app/admin/opengraph-image.alt.txt', 'made-up alt text\n');
write('src/app/robots.ts', 'export default function robots() { return {}; }\n');
write('src/app/manifest.json', '{}\n');
write('src/app/admin/logout/route.ts', 'export async function POST() { return new Response(); }\n');
write(
  'src/app/admin/sets/page.tsx',
  [
    'export default async function Page() {',
    '  async function save() {',
    "    'use server';",
    '  }',
    '  return save;',
    '}',
    '',
  ].join('\n'),
);
write(
  'src/components/form.tsx',
  ['// a form', 'export function Form() {', '  const act = async () => {', '    "use server";', '  };', '  return act;', '}', ''].join('\n'),
);
write('src/server/actions.ts', "/** Made-up actions. */\n'use strict';\n'use server';\nexport async function act() {}\n");
write('src/server/mentions.ts', "// never write an inline 'use server'\nexport const directive = 'use server';\n");

describe('the admin route finders', () => {
  it('list every page, Route Handler and metadata file, under the URL Next.js serves it at', () => {
    expect(appRoutes(sandbox)).toEqual([
      { path: '/admin', file: 'src/app/admin/page.tsx', kind: 'page' },
      { path: '/admin/icon', file: 'src/app/admin/icon.tsx', kind: 'metadata' },
      { path: '/admin/logout', file: 'src/app/admin/logout/route.ts', kind: 'route' },
      { path: '/admin/opengraph-image.png', file: 'src/app/admin/opengraph-image.png', kind: 'metadata' },
      { path: '/admin/sets', file: 'src/app/admin/sets/page.tsx', kind: 'page' },
      { path: '/manifest.json', file: 'src/app/manifest.json', kind: 'metadata' },
      { path: '/robots.txt', file: 'src/app/robots.ts', kind: 'metadata' },
    ]);
  });

  it('list every file that renders around a page, route groups dropped, and which are Client Components', () => {
    expect(segmentFiles(sandbox)).toEqual([
      { path: '/', file: 'src/app/layout.tsx', kind: 'layout', client: false },
      { path: '/admin', file: 'src/app/admin/error.tsx', kind: 'error', client: true },
      { path: '/admin', file: 'src/app/admin/layout.tsx', kind: 'layout', client: false },
      { path: '/admin/sets', file: 'src/app/admin/(group)/sets/loading.tsx', kind: 'loading', client: false },
    ]);
  });

  it("find each inline 'use server', in a function or an arrow, and no mention of one that is not a directive", () => {
    expect(inlineServerActions(sandbox)).toEqual(['src/app/admin/sets/page.tsx:3', 'src/components/form.tsx:4']);
  });

  it("find a module whose 'use server' directive follows a comment and another directive", () => {
    expect(serverActionModules(sandbox)).toEqual(['src/server/actions.ts']);
  });

  it('read a module prologue up to its first statement that is not a directive', () => {
    expect(directivesOf("'use client';\nimport x from 'y';\n'use server';\n", 'a.tsx')).toEqual({ module: ['use client'], inlineServer: [3] });
  });
});
