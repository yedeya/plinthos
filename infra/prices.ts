/**
 * The price refresh's background job (brief #226, Issue A, [VAL-9]): one Lambda function, whose
 * handler is `src/server/valuation/worker.ts`.
 *
 * - **Who may invoke it.** It has no URL. The admin's server may invoke it, because
 *   `infra/stack.ts` links the function to it, which grants `lambda:InvokeFunction` on this
 *   function's ARN alone and hands the server its name. The function may invoke itself, for the
 *   rest of a run, and nothing else: a function can't link itself, so its name is fixed here
 *   (`PRICE_JOB_NAME`), and its one extra permission is `lambda:InvokeFunction` on the ARN of that
 *   name in this account and region.
 * - **What it reaches.** The database through the Data API, the four BrickLink secrets the price
 *   lookup signs with ([VAL-1]), and the currency in its environment ([VAL-2]). Nothing else is
 *   linked: no session secret, no bucket. It is the only function linked to the BrickLink secrets
 *   (`PRICE_JOB_SECRETS`): the admin's server never asks BrickLink (#232).
 * - **How it runs.** Node 24 on arm64, 512 MB and a 15-minute timeout, of which one step uses about
 *   13 minutes. An asynchronous invocation that fails is not retried (`retries: 0`): the run's
 *   heartbeat goes stale, and it reads as stalled. No reserved concurrency: a new account's limit of
 *   10 can't spare it, and the run's lease in the database keeps two steps apart instead.
 *
 * At rest it costs nothing: no schedule, no VPC, no URL. A full refresh of about 3,600 lots is
 * about an hour at one call a second, 1,800 GB-seconds, inside Lambda's free tier (brief #226, §4).
 */

/** The SST secrets the function is linked to: the four BrickLink secrets, which nothing else holds (#232). */
export const PRICE_JOB_SECRETS = ['BrickLinkConsumerKey', 'BrickLinkConsumerSecret', 'BrickLinkTokenValue', 'BrickLinkTokenSecret'] as const;

/** The function's architecture, memory and timeout (brief #226, Issue A). */
export const PRICE_JOB_ARCHITECTURE = 'arm64';
export const PRICE_JOB_MEMORY = '512 MB';
export const PRICE_JOB_TIMEOUT = '15 minutes';
/** The worker's handler, the module `src/server/valuation/worker.ts` and its `handler` export. */
export const PRICE_JOB_HANDLER = 'src/server/valuation/worker.handler';

/** The function's name, fixed so that its own permission can name its ARN. */
export function priceJobName(app: { readonly name: string; readonly stage: string }): string {
  return `${app.name}-${app.stage}-PriceRefresh`;
}

export function createPriceJob(args: {
  /** The database and the four BrickLink secrets. */
  link: $util.Input<unknown>[];
  /** The deployment's region, which the function's own ARN names. */
  region: string;
  /** The ISO 4217 code BrickLink's prices are asked in ([VAL-2]). */
  currency: string;
}) {
  const name = priceJobName($app);
  const account = aws.getCallerIdentityOutput({}).accountId;
  const partition = aws.getPartitionOutput({}).partition;
  return new sst.aws.Function('PriceRefresh', {
    name,
    handler: PRICE_JOB_HANDLER,
    runtime: 'nodejs24.x',
    architecture: PRICE_JOB_ARCHITECTURE,
    memory: PRICE_JOB_MEMORY,
    timeout: PRICE_JOB_TIMEOUT,
    // A failed asynchronous invocation is not run again: the run's lease and heartbeat decide ([VAL-9]).
    retries: 0,
    link: args.link,
    environment: { PLINTHOS_CURRENCY: args.currency },
    // Invoking itself for the rest of a run, and nothing else.
    permissions: [{ actions: ['lambda:InvokeFunction'], resources: [$interpolate`arn:${partition}:lambda:${args.region}:${account}:function:${name}`] }],
  });
}
