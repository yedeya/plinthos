import type { OpenNextConfig } from '@opennextjs/aws/types/open-next.js';

// OpenNext's build of the admin's Next.js app (`npm run build`). It writes `.open-next/`, which
// `sst.aws.Nextjs` deploys as it is: the deploy never builds ([PLAT-4], infra/admin.ts).
const config = {
  default: {},
  buildCommand: 'npx next build',
} satisfies OpenNextConfig;

export default config;
