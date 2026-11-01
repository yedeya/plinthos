/**
 * The admin's shell: the Next.js app under `src/app/`, on Lambda through OpenNext, behind the
 * CloudFront distribution `sst.aws.Nextjs` creates for it. It serves `/health/live` and no admin
 * route yet; the first one arrives with its authorization check (#16).
 *
 * The deploy never builds. The deploy lane's build hook runs `npm run build` with no cloud
 * credential, and the deploy hook puts that output back in place before `sst deploy`
 * ([PLAT-4], K-SHIP-12). So the component's build command only checks that the output is there.
 *
 * Nothing here costs money at rest ([PLAT-5]): the server function is outside any VPC, no
 * instance is kept warm (a warmer is a schedule, [PLAT-7]), and there is no custom domain
 * (brief #6, decision 8). Every log group keeps 30 days, through `infra/guards.ts`.
 */

/** The OpenNext output `npm run build` writes, which the deploy needs in place. */
export const OPEN_NEXT_OUTPUT = '.open-next/open-next.output.json';

/** The build command `sst.aws.Nextjs` runs: a check that the prebuilt output is in place. */
export const PREBUILT_CHECK = `test -f ${OPEN_NEXT_OUTPUT} || { echo "No OpenNext build at ${OPEN_NEXT_OUTPUT}: run npm run build before sst deploy (docs/deploy.md)." >&2; exit 1; }`;

export function createAdmin() {
  return new sst.aws.Nextjs('Admin', {
    buildCommand: PREBUILT_CHECK,
    server: { runtime: 'nodejs24.x' },
  });
}
