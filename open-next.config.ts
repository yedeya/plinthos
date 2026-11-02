import type { OpenNextConfig } from '@opennextjs/aws/types/open-next.js';

/** The sharp version `package.json` pins, so the server function's binary is the one the tests ran (`tests/infra/photos.test.ts`). */
export const SHARP_VERSION = '0.35.5';

// OpenNext's build of the admin's Next.js app (`npm run build`). It writes `.open-next/`, which
// `sst.aws.Nextjs` deploys as it is: the deploy never builds ([PLAT-4], infra/admin.ts).
//
// The server function runs on arm64 (`infra/admin.ts`), and the build may run on any machine, so
// OpenNext installs sharp's Linux arm64 binary into the server function itself, the version
// `package.json` pins, for the photo re-encoding (#22, `src/server/photos/reencode.ts`).
//
// The server function streams its responses (#203): OpenNext's `aws-lambda-streaming` wrapper, so
// that a page's loading screen (`src/app/admin/loading.tsx`) reaches the browser while the page
// still waits for Aurora to resume. OpenNext marks the server origin `streaming` in its output,
// and `sst.aws.Nextjs` then gives the function's URL the `RESPONSE_STREAM` invoke mode, behind the
// same CloudFront distribution: configuration of the same function, no new resource.
export const SERVER_WRAPPER = 'aws-lambda-streaming';

const config = {
  default: {
    override: { wrapper: SERVER_WRAPPER },
    install: { packages: [`sharp@${SHARP_VERSION}`], arch: 'arm64', os: 'linux', libc: 'glibc' },
  },
  buildCommand: 'npx next build',
} satisfies OpenNextConfig;

export default config;
