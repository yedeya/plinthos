import type { NextConfig } from 'next';

// The admin's Next.js app, built by OpenNext into `.open-next/` (`npm run build`) and deployed
// by `sst.aws.Nextjs` in `infra/admin.ts`. Its App Router app lives under `src/app/`.
const config: NextConfig = {
  // Next.js checks and rewrites its own project file, never the root one the gates use.
  typescript: { tsconfigPath: 'tsconfig.next.json' },
  // Nothing on the admin's host is for search engines.
  headers: async () => [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }],
  poweredByHeader: false,
};

export default config;
