/**
 * What the admin's routes run against in the tests: the test database, a made-up sign-in
 * configuration, an in-memory attempt counter, and the request Next.js's `cookies()` and
 * `headers()` read. A test file wires it in with these mocks, before anything else:
 *
 *     vi.mock('../../src/server/database', async () => (await import('../support/admin-harness')).databaseMock);
 *     vi.mock('../../src/server/auth/config', async (original) => ({ ...(await original()), ...(await import('../support/admin-harness')).configMock }));
 *     vi.mock('../../src/server/auth/login-attempts', async () => (await import('../support/admin-harness')).countersMock);
 *     vi.mock('next/headers', async () => (await import('../support/admin-harness')).headersMock);
 *
 * `harness.databaseCalls` counts every call that reached for the database, which is how a test
 * proves a request never did ([AUTH-6]).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ReactNode } from 'react';
import { prerender } from 'react-dom/static';
import ts from 'typescript';
import type { AuthConfig } from '../../src/server/auth/config';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';
import type { AttemptCounter } from '../../src/server/auth/rate-limit';
import { repoRoot } from './repo-file';

export const harness = {
  db: undefined as unknown,
  config: undefined as AuthConfig | undefined,
  counter: undefined as AttemptCounter | undefined,
  databaseCalls: 0,
  /** The request `cookies()` and `headers()` answer for: a page render or a Server Action. */
  request: new Headers(),
};

export const databaseMock = {
  database: () => {
    harness.databaseCalls++;
    if (harness.db === undefined) throw new Error('the test set no database');
    return harness.db;
  },
};

export const configMock = {
  authConfig: () => {
    if (harness.config === undefined) throw new Error('the test set no auth configuration');
    return harness.config;
  },
};

export const countersMock = {
  loginAttemptCounter: () => {
    if (harness.counter === undefined) throw new Error('the test set no attempt counter');
    return harness.counter;
  },
};

function cookieMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (harness.request.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) map.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return map;
}

export const headersMock = {
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieMap().get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => harness.request,
};

/** Whether an error is a redirect or a not-found that Next.js's navigation functions throw. */
function isNavigation(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && /^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK);/.test(digest);
}

/**
 * Renders a tree to HTML with React's own server renderer, as Next.js renders a page or a layout,
 * so that every component in it runs: the async Server Components it nests at any depth, and its
 * Client Components, which Next.js renders on the server too (#67). Calling a Server Component's
 * function only returns its tree and runs none of them. A render that ends in a redirect or a
 * not-found answers `undefined`. Any other failure is thrown, so a component that broke before it
 * reached for the database can't pass for one that never does.
 */
export async function renderTree(element: ReactNode): Promise<string | undefined> {
  const errors: unknown[] = [];
  let html: string | undefined;
  try {
    const { prelude } = await prerender(element, { onError: (error) => void errors.push(error) });
    html = await new Response(prelude).text();
  } catch (error) {
    errors.push(error);
  }
  const failure = errors.find((error) => !isNavigation(error));
  if (failure !== undefined) throw failure;
  return errors.length === 0 ? html : undefined;
}

/** The `Cookie` header that carries a session cookie value. */
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}`;
}

/** The session cookie's value in a response's `Set-Cookie`, if it sets one. */
export function cookieSetBy(response: Response): string | undefined {
  const header = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header);
  return match?.[1] || undefined;
}

export interface AppRoute {
  /** The URL path, with route groups dropped, such as `/admin/logout`. */
  readonly path: string;
  /** The file, repository-relative. */
  readonly file: string;
  /**
   * A page, a Route Handler, or a metadata file (an icon, a shared image, a robots file, a
   * sitemap, a manifest), which Next.js serves as a route of its own and no admin wrapper fits.
   */
  readonly kind: 'page' | 'route' | 'metadata';
}

const CODE = /\.(tsx?|jsx?|mjs)$/;
const METADATA = /^(favicon|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*|robots|sitemap|manifest)\./;
/** What a metadata module is served as, where Next.js adds an extension to its name. */
const METADATA_SERVED_AS: Record<string, string> = { robots: 'robots.txt', sitemap: 'sitemap.xml', manifest: 'manifest.webmanifest' };

/** Every file under a directory, recursively, with its full path. */
function filesUnder(directory: string): { name: string; parentPath: string; file: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, parentPath: entry.parentPath, file: join(entry.parentPath, entry.name) }));
}

/** A directory's URL path under `src/app/`, with route groups dropped. */
function segmentPath(app: string, directory: string): string {
  return `/${relative(app, directory)
    .split(sep)
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
    .join('/')}`;
}

function byPathThenFile(a: { path: string; file: string }, b: { path: string; file: string }): number {
  return a.path.localeCompare(b.path) || a.file.localeCompare(b.file);
}

/**
 * Every page, Route Handler and metadata file under `src/app/`, from the files themselves. A
 * test may pass another root holding a made-up `src/app/`.
 */
export function appRoutes(root: string = repoRoot): AppRoute[] {
  const app = join(root, 'src', 'app');
  const routes: AppRoute[] = [];
  for (const { name, parentPath, file } of filesUnder(app)) {
    const path = segmentPath(app, parentPath);
    if (/^(page|route)\.(tsx?|jsx?|mjs)$/.test(name)) {
      routes.push({ path, file: relative(root, file), kind: name.startsWith('page') ? 'page' : 'route' });
    } else if (METADATA.test(name) && !name.endsWith('.alt.txt')) {
      const stem = name.slice(0, name.indexOf('.'));
      const served = CODE.test(name) ? (METADATA_SERVED_AS[stem] ?? stem) : name;
      routes.push({ path: `${path === '/' ? '' : path}/${served}`, file: relative(root, file), kind: 'metadata' });
    }
  }
  return routes.sort(byPathThenFile);
}

/**
 * The files Next.js renders around a page, beside it rather than inside it: a layout, a template,
 * a loading or error state and the rest. Each runs its own server code for every request under
 * its segment, in parallel with the page, so a page that refuses a request doesn't stop them.
 */
export const SEGMENT_FILES = [
  'layout',
  'template',
  'default',
  'loading',
  'not-found',
  'forbidden',
  'unauthorized',
  'error',
  'global-error',
  'global-not-found',
] as const;

export interface SegmentFile {
  /** The URL path of the segment it renders around, with route groups dropped. */
  readonly path: string;
  /** The file, repository-relative. */
  readonly file: string;
  readonly kind: (typeof SEGMENT_FILES)[number];
  /** Whether it is a Client Component (`'use client'`), which Next.js renders on the server too. */
  readonly client: boolean;
}

/** Every layout, template and other segment file under `src/app/` (`SEGMENT_FILES`). */
export function segmentFiles(root: string = repoRoot): SegmentFile[] {
  const app = join(root, 'src', 'app');
  const pattern = new RegExp(`^(${SEGMENT_FILES.join('|')})\\.(tsx?|jsx?|mjs)$`);
  const segments: SegmentFile[] = [];
  for (const { name, parentPath, file } of filesUnder(app)) {
    const kind = pattern.exec(name)?.[1] as SegmentFile['kind'] | undefined;
    if (kind === undefined) continue;
    const client = directivesOf(readFileSync(file, 'utf8'), name).module.includes('use client');
    segments.push({ path: segmentPath(app, parentPath), file: relative(root, file), kind, client });
  }
  return segments.sort(byPathThenFile);
}

/** The directives a source file declares, read from its syntax tree. */
export interface Directives {
  /** The module's own directives, such as `'use server'` or `'use client'`: its prologue. */
  readonly module: string[];
  /**
   * The line of every other `'use server'` statement: an inline Server Action, inside a function.
   * Next.js registers the function it marks as an action of its own, reachable by a POST with its
   * id whatever the page around it checks, and `adminAction` can't wrap it: the wrapper would
   * hold a reference to the action, never stand in front of it.
   */
  readonly inlineServer: number[];
}

/** Reads a module's directives, and every `'use server'` outside its prologue. */
export function directivesOf(source: string, fileName: string): Directives {
  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.ts')
      ? ts.ScriptKind.TS
      : fileName.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const prologue = new Set<ts.Node>();
  const module: string[] = [];
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    prologue.add(statement);
    module.push(statement.expression.text);
  }
  const inlineServer: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'use server' && !prologue.has(node)) {
      inlineServer.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { module, inlineServer };
}

/** Every source module under `src/`, repository-relative, with its directives. */
function sourceDirectives(root: string): { file: string; directives: Directives }[] {
  return filesUnder(join(root, 'src'))
    .filter(({ name }) => CODE.test(name))
    .map(({ name, file }) => ({ file: relative(root, file), directives: directivesOf(readFileSync(file, 'utf8'), name) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Every module under `src/` that declares Server Actions with a module-level `'use server'` directive. */
export function serverActionModules(root: string = repoRoot): string[] {
  return sourceDirectives(root)
    .filter(({ directives }) => directives.module.includes('use server'))
    .map(({ file }) => file);
}

/** Every inline Server Action under `src/`, as `file:line`: a `'use server'` anywhere but a module's prologue. */
export function inlineServerActions(root: string = repoRoot): string[] {
  return sourceDirectives(root).flatMap(({ file, directives }) => directives.inlineServer.map((line) => `${file}:${line}`));
}

/** Whether a path is the admin's, behind the check. */
export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/');
}

/**
 * The public allow-list ([AUTH-4]), by name: the login, `/health/live`, the web app manifest, the
 * service worker script and the data-free offline shell (#21). The static build assets are not
 * routes of `src/app/`.
 */
export const PUBLIC_ROUTES = ['/auth/login', '/health/live', '/login', '/manifest.webmanifest', '/offline', '/sw.js'] as const;

/** The HTTP methods a Route Handler module may export. */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
