/**
 * The one logger server code writes through ([OPS-1], AGENTS.md §2).
 *
 * Every event is one JSON line on standard output, which Lambda sends to the server function's
 * log group as it is. An event that matters carries a `businessEvent` field, a dot-separated
 * lowercase name such as `admin.request.failed`, and `docs/observability.md` says what each one
 * means and why it pages or not (`tests/infra/observability.test.ts`, [OPS-3]). No other module
 * imports pino, and lint refuses a `console` call under `src/` (`tests/server/logger.test.ts`).
 *
 * The logger redacts every field whose key names a secret, wherever it sits in the event up to
 * four levels down, including inside a logged error and its request headers ([OPS-2]).
 * Redaction works on keys, not values: never put a secret into a message or an error message.
 */
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * The keys whose values never reach a log line ([OPS-2]): every secret the app holds or will
 * hold. That is each SST secret `infra/config.ts` declares, under its camel-case name, and the
 * session's, the password's, the external APIs' and the request's own credentials. Keys match
 * exactly and case-sensitively; headers arrive lowercase from Next.js and from `fetch`.
 */
export const REDACTED_KEYS = [
  // The SST secrets (infra/config.ts). The username and the e-mail address are not credentials,
  // but they identify the owner, and the repository and its logs are no place for either.
  'adminUsername',
  'adminPasswordHash',
  'sessionSecret',
  'alertEmail',
  // The admin's credentials and session.
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'session',
  'sessionId',
  'sessionToken',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  // The catalogue token makes the public catalogue reachable (AGENTS.md §1).
  'publicToken',
  'public_token',
  // The external APIs' keys: Rebrickable's key, BrickLink's OAuth consumer and token pairs.
  'apiKey',
  'consumerKey',
  'consumerSecret',
  'tokenValue',
  'tokenSecret',
  // A request's and a response's credentials, as header names.
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
] as const;

/** How deep below the event's top level a redacted key is still found. */
const DEPTH = 4;

/** The censor that replaces each redacted value. */
export const CENSOR = '[Redacted]';

/** pino's redaction paths: each key at the top level and under one to four levels of wildcard. */
export const REDACT_PATHS: readonly string[] = REDACTED_KEYS.flatMap((key) => {
  const leaf = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  return Array.from({ length: DEPTH + 1 }, (_, depth) => {
    const prefix = '*.'.repeat(depth);
    return leaf.startsWith('[') ? (depth === 0 ? leaf : `${prefix.slice(0, -1)}${leaf}`) : `${prefix}${leaf}`;
  });
});

/**
 * Builds a logger. Production code uses `logger` below; tests pass a destination they can read.
 * Standard output is written synchronously, so no line is lost when Lambda freezes the function.
 */
export function createLogger(destination: DestinationStream = pino.destination({ dest: 1, sync: true })): Logger {
  return pino(
    {
      level: 'info',
      // No pid or hostname: on Lambda both are noise.
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    },
    destination,
  );
}

/** The one logger ([OPS-1]). */
export const logger: Logger = createLogger();
