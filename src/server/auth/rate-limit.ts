/**
 * The login's rate limit ([AUTH-12]): attempts are counted per client address and in total, in
 * fixed 15-minute windows. Once either count passes its limit, every further attempt in that
 * window is refused with 429 before the password is checked. The limits are the deployment's
 * configuration (`./config.ts`), 10 per address and 100 in total when it sets none.
 *
 * An attempt counts toward the total only while its address is within its own limit, and the
 * configuration keeps the per-address limit below the total, so one address alone can't use up
 * the total and lock every other address out ([AUTH-13], #58). Many addresses together still
 * can: that is what the total is for. The address is the viewer's, which the admin's CloudFront
 * distribution sets (`VIEWER_ADDRESS_HEADER`). A caller of the server function's own URL could
 * set its own, so the login refuses a request that did not come through the distribution before
 * it counts anything ([AUTH-14], `./via-cloudfront.ts`).
 *
 * The counts live in a DynamoDB on-demand table with a TTL (`infra/auth.ts`, brief #6,
 * decision 14), never in Aurora, so a bot's attempts never wake the database ([AUTH-6]), and not
 * in memory, which each Lambda instance would reset. An address is stored as its hash, never as
 * it arrived. Each call has a timeout and the SDK's own backoff (`AGENTS.md` §1); when the table
 * can't be reached the attempt fails rather than going uncounted.
 */
import { createHash } from 'node:crypto';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

/** The limits: per address, and for every address together. */
export interface LoginLimits {
  readonly windowSeconds: number;
  readonly perAddress: number;
  readonly total: number;
}

/** The limits when the deployment sets none (#62). The window is not configuration. */
export const LOGIN_LIMITS: LoginLimits = {
  windowSeconds: 15 * 60,
  perAddress: 10,
  total: 100,
};

/** Adds one to a counter that expires at the given time, and returns its new value. */
export interface AttemptCounter {
  increment(key: string, expiresAtSeconds: number): Promise<number>;
}

export type AttemptDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly scope: 'address' | 'total'; readonly retryAfterSeconds: number };

/** The address as the table stores it: a hash, so the table holds no IP address. */
export function addressKey(address: string): string {
  return createHash('sha256').update(`plinthos.login.address\0${address}`).digest('base64url').slice(0, 22);
}

/** Counts one login attempt from `address` and says whether it may go on. */
export async function countLoginAttempt(
  address: string,
  counter: AttemptCounter,
  nowMs: number = Date.now(),
  limits: LoginLimits = LOGIN_LIMITS,
): Promise<AttemptDecision> {
  const now = Math.floor(nowMs / 1000);
  const windowStart = now - (now % limits.windowSeconds);
  const windowEnd = windowStart + limits.windowSeconds;
  // Kept a window past its end, so the TTL's lag never resets a live count.
  const expiresAt = windowEnd + limits.windowSeconds;
  const retryAfterSeconds = Math.max(1, windowEnd - now);
  const byAddress = await counter.increment(`address#${addressKey(address)}#${windowStart}`, expiresAt);
  // An address past its own limit is refused without touching the total.
  if (byAddress > limits.perAddress) return { allowed: false, scope: 'address', retryAfterSeconds };
  const total = await counter.increment(`total#${windowStart}`, expiresAt);
  if (total > limits.total) return { allowed: false, scope: 'total', retryAfterSeconds };
  return { allowed: true };
}

/** How long one call to the table may take, and how many times the SDK tries it. */
export const DYNAMO_TIMEOUT_MS = 3_000;
export const DYNAMO_MAX_ATTEMPTS = 3;

/** The counter over the DynamoDB table: one atomic `UpdateItem` per count. */
export function dynamoCounter(tableName: string, client?: { send(command: UpdateItemCommand): Promise<unknown> }): AttemptCounter {
  const dynamo =
    client ??
    new DynamoDBClient({
      maxAttempts: DYNAMO_MAX_ATTEMPTS,
      requestHandler: { requestTimeout: DYNAMO_TIMEOUT_MS, connectionTimeout: 1_000 },
    });
  return {
    async increment(key, expiresAtSeconds) {
      const result = (await dynamo.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: { S: key } },
          UpdateExpression: 'ADD attempts :one SET expiresAt = if_not_exists(expiresAt, :expiresAt)',
          ExpressionAttributeValues: { ':one': { N: '1' }, ':expiresAt': { N: String(expiresAtSeconds) } },
          ReturnValues: 'UPDATED_NEW',
        }),
      )) as { Attributes?: { attempts?: { N?: string } } };
      const attempts = Number(result.Attributes?.attempts?.N);
      if (!Number.isInteger(attempts)) throw new Error('The login-attempt table answered without a count.');
      return attempts;
    },
  };
}

/**
 * The header the admin's CloudFront distribution sets to the viewer's address, overwriting any
 * value the viewer sent (`infra/admin.ts`). Without it the attempt counts under `unknown`.
 */
export const VIEWER_ADDRESS_HEADER = 'x-plinthos-viewer-address';
