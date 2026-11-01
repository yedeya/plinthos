import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LOGIN_PATH as SERVER_LOGIN_PATH } from '../../../src/server/auth/admin';
import { ICONS, LOGIN_PATH, SHELL_PATH, SHELL_PRECACHE, WORKER_PATH } from '../../../src/app/_offline/shell';
import { PUBLIC_ROUTES } from '../../support/admin-harness';
import { repoRoot } from '../../support/repo-file';

// The shell is public: rendering it must never reach for a cookie, a header or the database.
const reached = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    reached.calls.push('cookies');
    throw new Error('the shell read a cookie');
  },
  headers: async () => {
    reached.calls.push('headers');
    throw new Error('the shell read a header');
  },
}));
vi.mock('../../../src/server/database', () => ({
  database: () => {
    reached.calls.push('database');
    throw new Error('the shell called the database');
  },
}));

const manifestModule = await import('../../../src/app/manifest');
const offlineModule = await import('../../../src/app/offline/page');
const layoutModule = await import('../../../src/app/layout');

/**
 * `[SYNC-5]` and `[AUTH-4]`: the manifest, the worker script and the shell at `/offline` are
 * public and carry no data, and they are what makes the admin installable.
 */

/** A PNG's width and height, from its header. */
function pngSize(file: string): string {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe('the installable admin', () => {
  it('[SYNC-5] [AUTH-4] the manifest, the worker script and the shell are on the public allow-list, by name', () => {
    expect(PUBLIC_ROUTES).toEqual(expect.arrayContaining(['/manifest.webmanifest', WORKER_PATH, SHELL_PATH]));
    expect(LOGIN_PATH).toBe(SERVER_LOGIN_PATH);
  });

  it('[SYNC-5] serves a manifest that installs the admin standalone, opening at /admin, with icons that exist', () => {
    expect(manifestModule.dynamic).toBe('force-static');
    const manifest = manifestModule.default();
    expect(manifest).toMatchObject({ name: expect.any(String), short_name: expect.any(String), start_url: '/admin', scope: '/', display: 'standalone' });
    const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of ICONS) {
      expect(pngSize(join(repoRoot, 'public', icon.src)), icon.src).toBe(icon.sizes);
      expect(SHELL_PRECACHE).toContain(icon.src);
    }
    expect(SHELL_PRECACHE).toContain('/manifest.webmanifest');
    for (const path of SHELL_PRECACHE) expect(path.startsWith('/admin'), path).toBe(false);
  });

  it('[SYNC-5] [AUTH-4] prerenders /offline from nothing but the page itself: no cookie, no header, no database', () => {
    expect(offlineModule.dynamic).toBe('force-static');
    const html = renderToStaticMarkup(createElement(offlineModule.default));
    expect(html).toContain('aria-label="Offline queue"');
    expect(html).toContain('href="/admin"');
    expect(reached.calls).toEqual([]);
  });

  it('[SYNC-5] registers the worker from the root layout, so every page of the admin installs it', () => {
    const html = renderToStaticMarkup(createElement(layoutModule.default, null, createElement('p', null, 'page')));
    expect(html).toContain('<p>page</p>');
    expect(readFileSync(join(repoRoot, 'src/app/layout.tsx'), 'utf8')).toMatch(/<ServiceWorkerRegistration \/>/);
    expect(reached.calls).toEqual([]);
  });
});
