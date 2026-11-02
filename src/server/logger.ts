/**
 * The one logger server code writes through ([OPS-1], AGENTS.md §2).
 *
 * Every event is one JSON line on standard output, which Lambda sends to the server function's
 * log group as it is. An event that matters carries a `businessEvent` field, a dot-separated
 * lowercase name such as `admin.request.failed`, and `docs/observability.md` says what each one
 * means and why it pages or not (`tests/infra/observability.test.ts`, [OPS-3]). No other module
 * imports pino, and lint refuses a `console` call under `src/` (`tests/server/logger.test.ts`).
 *
 * The logger redacts every field whose key names a secret, in any letter case and however deep it
 * sits in the event, including inside a logged error, its request headers and a child logger's
 * bindings ([OPS-2]). A second layer works on values: the session secret's and the admin password
 * hash's values, which the server function holds, are scrubbed from every line wherever they
 * appear, in a message string or an error's message included (`SCRUBBED_SECRETS`), and so is the
 * Rebrickable API key's ([CAT-4]). Any other secret is redacted by its key alone, so never put one
 * into a message or an error message.
 */
import pino, { type DestinationStream, type Logger } from 'pino';
import { linkedValue } from './linked';

export type { Logger };

/**
 * The keys whose values never reach a log line ([OPS-2]): every secret the app holds or will
 * hold. That is each SST secret `infra/config.ts` declares, under its camel-case name, and the
 * session's, the password's, the external APIs' and the request's own credentials. Keys match in
 * any letter case: header names are case-insensitive, and a plain-object `headers` map, such as
 * an HTTP client's request config inside its error, keeps whatever case its author wrote.
 */
export const REDACTED_KEYS = [
  // The SST secrets (infra/config.ts). The username and the e-mail address are not credentials,
  // but they identify the owner, and the repository and its logs are no place for either.
  'adminUsername',
  'adminPasswordHash',
  'sessionSecret',
  'alertEmail',
  'rebrickableApiKey',
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

/** The censor that replaces each redacted value. */
export const CENSOR = '[Redacted]';

/** The redacted keys in lower case, the form a key is compared in. */
const REDACTED = new Set<string>(REDACTED_KEYS.map((key) => key.toLowerCase()));

/** Replaces, in place, every value under a redacted key; says whether it replaced any. */
function redactIn(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  let redacted = false;
  for (const key of Object.keys(record)) {
    if (REDACTED.has(key.toLowerCase())) {
      record[key] = CENSOR;
      redacted = true;
    } else if (redactIn(record[key])) {
      redacted = true;
    }
  }
  return redacted;
}

/**
 * Redacts one finished log line, after pino has serialized the event, its error and its child
 * bindings. pino's own `redact` matches exact paths only, so it can't see `Authorization` for
 * `authorization`. A line with nothing to redact is written exactly as pino made it. A line that
 * can't be parsed is replaced, never written unredacted.
 */
export function redactLine(line: string): string {
  try {
    const event: unknown = JSON.parse(line);
    return redactIn(event) ? `${JSON.stringify(event)}\n` : line;
  } catch {
    return `${JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: 'A log line was dropped because it could not be redacted.' })}\n`;
  }
}

/**
 * The SST secrets whose values the server function holds, and which are scrubbed from every line
 * by value ([OPS-2], #16): the logger reads them from the function's links when it is built.
 */
export const SCRUBBED_SECRETS = ['SessionSecret', 'AdminPasswordHash', 'RebrickableApiKey'] as const;

/** A value shorter than this is not scrubbed: it would match ordinary text, and is no real secret. */
export const MIN_SCRUBBED_LENGTH = 8;

/** The linked values of `SCRUBBED_SECRETS`, where the function has them. */
export function linkedSecretValues(): string[] {
  return SCRUBBED_SECRETS.map((name) => linkedValue(name)).filter((value): value is string => value !== undefined);
}

/**
 * Replaces every occurrence of each value in a finished line, in the forms a JSON line can hold
 * it: as it is, and escaped as a JSON string. Longer values go first, so a value that contains
 * another is scrubbed whole.
 */
export function scrubValues(line: string, values: readonly string[]): string {
  let scrubbed = line;
  const forms = values
    .filter((value) => value.length >= MIN_SCRUBBED_LENGTH)
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const form of new Set(forms)) scrubbed = scrubbed.split(form).join(CENSOR);
  return scrubbed;
}

export interface LoggerOptions {
  /** Values scrubbed from every line. Defaults to the linked `SCRUBBED_SECRETS`. */
  readonly secretValues?: readonly string[];
}

/**
 * Builds a logger. Production code uses `logger` below; tests pass a destination they can read.
 * Standard output is written synchronously, so no line is lost when Lambda freezes the function.
 */
export function createLogger(
  destination: DestinationStream = pino.destination({ dest: 1, sync: true }),
  options: LoggerOptions = {},
): Logger {
  const secretValues = [...(options.secretValues ?? linkedSecretValues())];
  const write = secretValues.length === 0 ? redactLine : (line: string) => scrubValues(redactLine(line), secretValues);
  return pino(
    {
      level: 'info',
      // No pid or hostname: on Lambda both are noise.
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      hooks: { streamWrite: write },
    },
    destination,
  );
}

/** The one logger ([OPS-1]). */
export const logger: Logger = createLogger();
