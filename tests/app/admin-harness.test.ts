import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { afterAll, describe, expect, it } from 'vitest';
import { appRoutes, directivesOf, everyName, inlineServerActions, renderTree, segmentFiles, serverActionModules } from '../support/admin-harness';

/**
 * #59: the finders `tests/app/admin-routes.test.ts` walks catch every form an admin surface can
 * take, shown on a made-up app directory, since the real one holds none of the forms they refuse.
 * #67: the renderer it renders public pages and layouts with runs every component in their tree.
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

describe('the renderer the route tests render a tree with', () => {
  let reads = 0;
  async function CollectionName(): Promise<ReactNode> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    reads++;
    return createElement('span', null, 'Made-up collection');
  }
  async function Header(): Promise<ReactNode> {
    return createElement('header', null, createElement(CollectionName));
  }
  function Layout({ children }: { readonly children: ReactNode }): ReactNode {
    return createElement('html', null, createElement('body', null, createElement(Header), children));
  }

  it('runs an async Server Component nested in the tree, which calling the layout itself does not', async () => {
    reads = 0;
    Layout({ children: null });
    expect(reads).toBe(0);
    expect(await renderTree(createElement(Layout, { children: null }))).toContain('Made-up collection');
    expect(reads).toBe(1);
  });

  it('ends without a page on a redirect or a not-found, and throws any other failure', async () => {
    const throwing = (fail: () => never) =>
      createElement(Layout, { children: createElement(async () => fail()) });
    expect(await renderTree(throwing(() => redirect('/login')))).toBeUndefined();
    expect(await renderTree(throwing(() => notFound()))).toBeUndefined();
    await expect(
      renderTree(
        throwing(() => {
          throw new Error('made-up failure');
        }),
      ),
    ).rejects.toThrow('made-up failure');
  });
});

describe('the made-up params and query the route tests render every name present with', () => {
  it('answer a check on whether a name is there as present, by a read, by `in` and by an own-property check (#81)', async () => {
    const present: Record<string, boolean> = {};
    async function Page({ searchParams }: { readonly searchParams: Promise<Record<string, string | undefined>> }): Promise<ReactNode> {
      const query = await searchParams;
      const { failed } = query;
      present.read = failed !== undefined;
      present.in = 'failed' in query;
      present.reflect = Reflect.has(query, 'failed');
      present.hasOwn = Object.hasOwn(query, 'failed');
      present.prototypeHasOwn = Object.prototype.hasOwnProperty.call(query, 'failed');
      return null;
    }
    await renderTree(createElement(Page, { searchParams: Promise.resolve(everyName) }));
    expect(present).toEqual({ read: true, in: true, reflect: true, hasOwn: true, prototypeHasOwn: true });
  });

  it('are no thenable, so awaiting the promise that holds them gives the names back', async () => {
    expect('then' in everyName).toBe(false);
    expect(Object.hasOwn(everyName, 'then')).toBe(false);
    expect(await Promise.resolve(everyName)).toBe(everyName);
  });
});
