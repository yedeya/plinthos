/**
 * The admin's shell: the Next.js app under `src/app/`, on Lambda through OpenNext, behind the
 * CloudFront distribution `sst.aws.Nextjs` creates for it. It serves `/health/live`, the login
 * and the admin's pages, each admin route behind its own check (#16, [AUTH-3]).
 *
 * The server function is linked to what the sign-in reads ([AUTH-2], [AUTH-12]): the admin's
 * username and password hash, the session secret, the database (for the sessions) and the
 * login-attempt table. `AlertEmail` is not linked: the function has no use for it. The session
 * lifetimes ([AUTH-11]) and the login limits ([AUTH-12]) reach it in its environment. The
 * distribution's viewer-request function sets `x-plinthos-viewer-address` to the viewer's
 * address, overwriting any value the viewer sent, which is the address the rate limiter counts
 * per.
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

/** The header the viewer-request function sets (`src/server/auth/rate-limit.ts`). */
export const VIEWER_ADDRESS_HEADER = 'x-plinthos-viewer-address';

/** The CloudFront Function code that sets it, from the address CloudFront saw. */
export const VIEWER_ADDRESS_INJECTION = `event.request.headers["${VIEWER_ADDRESS_HEADER}"] = { value: event.viewer.ip };`;

/** The SST secrets the server function is linked to. */
export const LINKED_SECRETS = ['AdminUsername', 'AdminPasswordHash', 'SessionSecret'] as const;

export function createAdmin(args: {
  link: $util.Input<unknown>[];
  sessionIdleDays: number;
  sessionAbsoluteDays: number;
  loginAttemptsPerAddress: number;
  loginAttemptsTotal: number;
}) {
  return new sst.aws.Nextjs('Admin', {
    buildCommand: PREBUILT_CHECK,
    server: { runtime: 'nodejs24.x' },
    link: args.link,
    environment: {
      PLINTHOS_SESSION_IDLE_DAYS: String(args.sessionIdleDays),
      PLINTHOS_SESSION_ABSOLUTE_DAYS: String(args.sessionAbsoluteDays),
      PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS: String(args.loginAttemptsPerAddress),
      PLINTHOS_LOGIN_ATTEMPTS_TOTAL: String(args.loginAttemptsTotal),
    },
    edge: { viewerRequest: { injection: VIEWER_ADDRESS_INJECTION } },
  });
}
