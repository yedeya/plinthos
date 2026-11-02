/**
 * The admin's shell: the Next.js app under `src/app/`, on Lambda through OpenNext, behind the
 * CloudFront distribution `sst.aws.Nextjs` creates for it. It serves `/health/live`, the login
 * and the admin's pages, each admin route behind its own check (#16, [AUTH-3]).
 *
 * The server function is linked to what the sign-in reads ([AUTH-2], [AUTH-12]): the admin's
 * username and password hash, the session secret, the database (for the sessions) and the
 * login-attempt table, and to `RebrickableApiKey`, which the set lookup sends to Rebrickable from the
 * server only ([CAT-4], `src/server/catalogue/rebrickable.ts`). `AlertEmail` is not linked: the function has no use for it. The session
 * lifetimes ([AUTH-11]) and the login limits ([AUTH-12]) reach it in its environment. The
 * distribution's viewer-request function sets `x-plinthos-viewer-address` to the viewer's
 * address, overwriting any value the viewer sent, which is the address the rate limiter counts
 * per. It also sets `x-plinthos-origin` to a value derived from `SessionSecret`, which the login
 * checks before anything else, so a caller of the server function's own URL, which SST leaves
 * open, can't choose that address ([AUTH-14], `src/server/auth/via-cloudfront.ts`). The URL
 * stays open because plain OAC would refuse the login form's POST (`docs/deploy.md`).
 *
 * The deploy never builds. The deploy lane's build hook runs `npm run build` with no cloud
 * credential, and the deploy hook puts that output back in place before `sst deploy`
 * ([PLAT-4], K-SHIP-12). So the component's build command only checks that the output is there.
 *
 * Nothing here costs money at rest ([PLAT-5]): the server function is outside any VPC, no
 * instance is kept warm (a warmer is a schedule, [PLAT-7]), and there is no custom domain
 * (brief #6, decision 8). Every log group keeps 30 days, through `infra/guards.ts`.
 */

import { createHmac } from 'node:crypto';

/** The OpenNext output `npm run build` writes, which the deploy needs in place. */
export const OPEN_NEXT_OUTPUT = '.open-next/open-next.output.json';

/** The build command `sst.aws.Nextjs` runs: a check that the prebuilt output is in place. */
export const PREBUILT_CHECK = `test -f ${OPEN_NEXT_OUTPUT} || { echo "No OpenNext build at ${OPEN_NEXT_OUTPUT}: run npm run build before sst deploy (docs/deploy.md)." >&2; exit 1; }`;

/** The header the viewer-request function sets (`src/server/auth/rate-limit.ts`). */
export const VIEWER_ADDRESS_HEADER = 'x-plinthos-viewer-address';

/** The CloudFront Function code that sets it, from the address CloudFront saw. */
export const VIEWER_ADDRESS_INJECTION = `event.request.headers["${VIEWER_ADDRESS_HEADER}"] = { value: event.viewer.ip };`;

/** The header that proves a request came through the distribution (`src/server/auth/via-cloudfront.ts`). */
export const ORIGIN_HEADER = 'x-plinthos-origin';

/** Its value, an HMAC of the session secret, as `src/server/auth/via-cloudfront.ts` computes it. */
export function originSecret(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('plinthos.origin.v1').digest('base64url');
}

/** The viewer-request function's code: both headers, each an assignment that replaces the viewer's value. */
export function viewerRequestInjection(sessionSecret: string): string {
  return [VIEWER_ADDRESS_INJECTION, `event.request.headers["${ORIGIN_HEADER}"] = { value: "${originSecret(sessionSecret)}" };`].join('\n');
}

/** The server function's architecture and memory (#22): sharp's prebuilt arm64 binary, and room to decode a photo. */
export const SERVER_ARCHITECTURE = 'arm64';
export const SERVER_MEMORY = '1536 MB';

/**
 * The server function's timeout, set rather than left to SST's default of 20 seconds, so that the
 * photo cap has a number to fit (#95, [SYNC-10]). SST sets CloudFront's read timeout for the
 * server origin to the same value, and CloudFront allows at most 60 seconds without a quota
 * increase. It is shorter than the phone's `REPLAY_TIMEOUT_MS`, so the phone hears the server's
 * answer before it gives up, and longer than `MAX_PHOTOS_PER_BATCH` × `PHOTO_BUDGET_MS`
 * (`src/server/sync/limits.ts`), with the rest left for Aurora to resume from a pause. A timeout
 * costs nothing: Lambda bills the time a request runs, not the limit.
 */
export const SERVER_TIMEOUT_SECONDS = 55;
export const SERVER_TIMEOUT = `${SERVER_TIMEOUT_SECONDS} seconds` as const;

/** The SST secrets the server function is linked to. */
export const LINKED_SECRETS = ['AdminUsername', 'AdminPasswordHash', 'SessionSecret', 'RebrickableApiKey'] as const;

export function createAdmin(args: {
  link: $util.Input<unknown>[];
  /** The linked `SessionSecret`'s value, which the origin header's value is derived from. */
  sessionSecret: $util.Input<string>;
  sessionIdleDays: number;
  sessionAbsoluteDays: number;
  loginAttemptsPerAddress: number;
  loginAttemptsTotal: number;
  photoLongestEdge: number;
  photoMaxBytes: number;
}) {
  return new sst.aws.Nextjs('Admin', {
    buildCommand: PREBUILT_CHECK,
    // arm64, which the OpenNext build installs sharp's binary for (`open-next.config.ts`), and
    // the memory sharp needs to re-encode a phone's photo, as SST gives its own image optimizer
    // (#22). Lambda bills by the GB-second, inside the free tier at this volume (brief #6, §4).
    // The timeout bounds one offline-sync batch's photos (#95).
    server: { runtime: 'nodejs24.x', architecture: SERVER_ARCHITECTURE, memory: SERVER_MEMORY, timeout: SERVER_TIMEOUT },
    // The sign-in's secrets, the database, the rate limiter's table, the snapshot bucket and its
    // distribution for the publish step (`infra/snapshot.ts`), and the photo bucket (`infra/photos.ts`).
    link: args.link,
    environment: {
      PLINTHOS_SESSION_IDLE_DAYS: String(args.sessionIdleDays),
      PLINTHOS_SESSION_ABSOLUTE_DAYS: String(args.sessionAbsoluteDays),
      PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS: String(args.loginAttemptsPerAddress),
      PLINTHOS_LOGIN_ATTEMPTS_TOTAL: String(args.loginAttemptsTotal),
      PLINTHOS_PHOTO_LONGEST_EDGE: String(args.photoLongestEdge),
      PLINTHOS_PHOTO_MAX_BYTES: String(args.photoMaxBytes),
    },
    // Not secret in SST's state: SST builds the CloudFront Function inside its own `apply`, on the
    // plain string, so the function's code, the origin header's value with it, is plain text there
    // (`docs/deploy.md`).
    edge: { viewerRequest: { injection: $output(args.sessionSecret).apply(viewerRequestInjection) } },
  });
}
