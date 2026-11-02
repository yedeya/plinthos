import type { OpenNextConfig } from '@opennextjs/aws/types/open-next.js';

/** The sharp version `package.json` pins, so the server function's binary is the one the tests ran (`tests/infra/photos.test.ts`). */
export const SHARP_VERSION = '0.35.5';

// OpenNext's build of the admin's Next.js app (`npm run build`). It writes `.open-next/`, which
// `sst.aws.Nextjs` deploys as it is: the deploy never builds ([PLAT-4], infra/admin.ts).
//
// The server function runs on arm64 (`infra/admin.ts`), and the build may run on any machine, so
// OpenNext installs sharp's Linux arm64 binary into the server function itself, the version
// `package.json` pins, for the photo re-encoding (#22, `src/server/photos/reencode.ts`).
const config = {
  default: { install: { packages: [`sharp@${SHARP_VERSION}`], arch: 'arm64', os: 'linux', libc: 'glibc' } },
  buildCommand: 'npx next build',
} satisfies OpenNextConfig;

export default config;
