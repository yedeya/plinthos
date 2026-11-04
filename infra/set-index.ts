/**
 * The set index's builder and its schedule (brief #252, Issue A, [CAT-6] to [CAT-9]): one Lambda
 * function, whose handler is `src/server/catalogue/set-index/worker.ts`, run once a week by an
 * EventBridge Scheduler schedule.
 *
 * - **What it reaches.** Rebrickable's three download files over the internet, and the
 *   `set-index/` prefix of the private photo bucket (`infra/photos.ts`) through its link,
 *   `SetIndexWriter`: it may read, write and delete under that prefix alone, and list the bucket
 *   only with `s3:prefix` under it, so a missing key reads as missing rather than refused, and the
 *   first build writes the first index instead of failing ([CAT-7]). It is linked to no database
 *   and no secret ([CAT-6]): it never wakes Aurora ([CAT-8]).
 * - **Who reads the index.** The admin's server function, through `SetIndexReader`, which may read
 *   under `set-index/` and nothing more of it ([CAT-9]). No distribution has the photo bucket as an
 *   origin, so nothing public serves the index ([CAT-8]).
 * - **How it runs.** Node 24 on arm64, 512 MB and a 2-minute timeout. A failed invocation is not
 *   retried, by Lambda (`retries: 0`) or by the schedule (`retries: 0`): a failed build leaves the
 *   previous index working, and the next week's build tries again. Its name is fixed, so the owner
 *   can run it by hand after the first deploy (`docs/deploy.md`).
 * - **When.** Every Monday at 08:00 UTC, after Rebrickable's morning refresh of the files (brief
 *   #252, decision 4). The builder's own marker keeps any run, by hand or scheduled, to one fetch in
 *   24 hours ([CAT-8]). This is the one schedule the cost guard lets through (`infra/guards.ts`,
 *   [PLAT-7]), by its name and its expression.
 *
 * It costs about $0.01 a month or less, $0 inside the free tiers: about 4.3 runs a month of about
 * 15 seconds at 512 MB, a free schedule, two versions of about 640 KB in S3 and a few hundred
 * requests (brief #252, §4, the Owner's yes on 2026-11-03). No alarm, no NAT, no new bucket.
 */

/** The prefix of the photo bucket the index is kept under (`src/server/catalogue/set-index/format.ts`). */
export const SET_INDEX_PREFIX = 'set-index/';

/** The function's architecture, memory and timeout (brief #252, Issue A). */
export const SET_INDEX_ARCHITECTURE = 'arm64';
export const SET_INDEX_MEMORY = '512 MB';
export const SET_INDEX_TIMEOUT = '2 minutes';
/** The builder's handler, the module `src/server/catalogue/set-index/worker.ts` and its `handler` export. */
export const SET_INDEX_HANDLER = 'src/server/catalogue/set-index/worker.handler';

/** The schedule's component name; `sst.aws.CronV2` names its Scheduler schedule `<name>Schedule`. */
export const SET_INDEX_CRON = 'SetIndexBuild';
/** Every Monday at 08:00 UTC ([CAT-8]). */
export const SET_INDEX_SCHEDULE = 'cron(0 8 ? * MON *)';

/** The function's name, fixed so that `docs/deploy.md` can name it for a run by hand. */
export function setIndexBuilderName(app: { readonly name: string; readonly stage: string }): string {
  return `${app.name}-${app.stage}-SetIndexBuilder`;
}

export function createSetIndex(args: {
  /** The private photo bucket (`infra/photos.ts`). */
  bucket: { readonly arn: $util.Input<string>; readonly bucket: $util.Input<string> };
}) {
  const { bucket } = args;
  const writer = new sst.Linkable('SetIndexWriter', {
    properties: { bucket: bucket.bucket },
    include: [
      sst.aws.permission({ actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [$interpolate`${bucket.arn}/${SET_INDEX_PREFIX}*`] }),
      // A missing key reads as missing only to a caller that may list; this one may list its prefix alone.
      sst.aws.permission({
        actions: ['s3:ListBucket'],
        resources: [bucket.arn],
        conditions: [{ test: 'StringLike', variable: 's3:prefix', values: [`${SET_INDEX_PREFIX}*`] }],
      }),
    ],
  });
  const reader = new sst.Linkable('SetIndexReader', {
    properties: { bucket: bucket.bucket },
    include: [sst.aws.permission({ actions: ['s3:GetObject'], resources: [$interpolate`${bucket.arn}/${SET_INDEX_PREFIX}*`] })],
  });

  const builder = new sst.aws.Function('SetIndexBuilder', {
    name: setIndexBuilderName($app),
    handler: SET_INDEX_HANDLER,
    runtime: 'nodejs24.x',
    architecture: SET_INDEX_ARCHITECTURE,
    memory: SET_INDEX_MEMORY,
    timeout: SET_INDEX_TIMEOUT,
    // A failed invocation is not run again: the previous index stays, and next week's build tries again.
    retries: 0,
    link: [writer],
  });

  new sst.aws.CronV2(SET_INDEX_CRON, { function: builder.arn, schedule: SET_INDEX_SCHEDULE, retries: 0 });

  return { builder, reader };
}
