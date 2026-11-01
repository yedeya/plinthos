/**
 * `/manifest.webmanifest`: the web app manifest that makes the admin installable ([SYNC-5]), on
 * the public allow-list ([AUTH-4]). It names the app, its icons and where it opens, and nothing
 * else: no data, no cookie read. An installed admin opens at `/admin`; with no network the
 * service worker sends it to the shell at `/offline`.
 */
import type { MetadataRoute } from 'next';
import { ICONS } from './_offline/shell';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Plinthos admin',
    short_name: 'Plinthos',
    description: 'The private admin of one LEGO collection.',
    id: '/admin',
    start_url: '/admin',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#b40000',
    icons: ICONS.map((icon) => ({ ...icon, purpose: 'any' as const })),
  };
}
