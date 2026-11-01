/**
 * The login rate limiter's state ([AUTH-12], brief #6, decision 14): a DynamoDB table, billed
 * on demand, whose items expire through a TTL. Counting attempts here rather than in Aurora means
 * a bot's attempts never wake the database ([AUTH-6]).
 *
 * At rest it costs nothing: on-demand tables bill per request and per GB stored, and the table
 * holds a few hundred bytes of counters. Point-in-time recovery, which `sst.aws.Dynamo` turns on,
 * is turned off: the counters are worth nothing after their window, and it bills per GB.
 */

/** The item attribute the TTL reads, in epoch seconds (`src/server/auth/rate-limit.ts`). */
export const LOGIN_ATTEMPTS_TTL = 'expiresAt';

export function createLoginAttempts() {
  return new sst.aws.Dynamo('LoginAttempts', {
    fields: { pk: 'string' },
    primaryIndex: { hashKey: 'pk' },
    ttl: LOGIN_ATTEMPTS_TTL,
    transform: {
      table: (args) => {
        args.pointInTimeRecovery = { enabled: false };
      },
    },
  });
}
