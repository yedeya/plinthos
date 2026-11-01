/**
 * The offline shell's fixed names, shared by the service worker's script (`../sw.js/route.ts`),
 * the manifest (`../manifest.ts`) and the component that registers the worker.
 */

/** The data-free document the worker precaches and opens to without a network ([SYNC-5]). */
export const SHELL_PATH = '/offline';

/** The one cache the worker keeps. Bump its suffix only when what it stores changes shape. */
export const SHELL_CACHE = 'plinthos-shell-v1';

/** The worker script's path, at the root so its scope is the whole admin. */
export const WORKER_PATH = '/sw.js';

/** Where the queue sends the admin when the session has ended: the server's `LOGIN_PATH`. */
export const LOGIN_PATH = '/login';

/** The manifest's icons, public files under `public/`, kept with the shell. */
export const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
] as const;

/** The public files the worker keeps beside the shell and its build assets. */
export const SHELL_PRECACHE: readonly string[] = ['/manifest.webmanifest', ...ICONS.map((icon) => icon.src)];
