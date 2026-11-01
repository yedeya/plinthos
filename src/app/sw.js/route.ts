/**
 * `/sw.js`: the admin's service worker script, on the public allow-list ([AUTH-4], [SYNC-5]).
 *
 * It is the source of `serviceWorker` (`./worker.ts`), called with the shell's configuration. It
 * carries no data and reads no cookie, session or database, so it is the same for every visitor
 * and is prerendered at build time. Served from the site's root, its scope is the whole admin.
 * `no-cache` makes the browser and CloudFront ask again each time it checks for an update.
 */
import { SHELL_CACHE, SHELL_PATH, SHELL_PRECACHE } from '../_offline/shell';
import { serviceWorker, type WorkerConfig } from './worker';

export const dynamic = 'force-static';

/** The script the browser runs: the worker's own source, called on the worker's global scope. */
function workerScript(): string {
  const config: WorkerConfig = { cacheName: SHELL_CACHE, shellPath: SHELL_PATH, precache: SHELL_PRECACHE };
  return `'use strict';\n(${serviceWorker.toString()})(self, ${JSON.stringify(config)});\n`;
}

export function GET(): Response {
  return new Response(workerScript(), {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
