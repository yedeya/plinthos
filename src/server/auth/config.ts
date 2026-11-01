/**
 * The sign-in's configuration, all of it the deployment's ([AUTH-1], [PLAT-2]): the admin's
 * username and password hash and the session secret, the SST secrets `infra/admin.ts` links to
 * the server function, and the two session lifetimes, which it passes in the function's
 * environment ([AUTH-11]). There is no other source of an admin account: no route creates,
 * claims or resets one.
 *
 * Nothing here touches the database ([AUTH-2]). An invalid value fails the request that needs
 * it, naming the value but never printing it.
 */
import { z } from 'zod';
import { linkedValue } from '../linked';
import { parsePasswordHash, type PasswordHash } from './password';

/** The session lifetimes when the deployment sets none (brief #6, decision 3). */
export const DEFAULT_IDLE_DAYS = 7;
export const DEFAULT_ABSOLUTE_DAYS = 30;

/** The environment variables the server function reads the lifetimes from (`infra/admin.ts`). */
export const IDLE_DAYS_ENV = 'PLINTHOS_SESSION_IDLE_DAYS';
export const ABSOLUTE_DAYS_ENV = 'PLINTHOS_SESSION_ABSOLUTE_DAYS';

/** The shortest session secret accepted: `docs/deploy.md`'s command makes 64 characters. */
export const MIN_SESSION_SECRET_LENGTH = 32;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthConfig {
  readonly username: string;
  /** The secret's value as it was set, which the cookie key is derived from. */
  readonly passwordHashValue: string;
  readonly passwordHash: PasswordHash;
  readonly sessionSecret: string;
  readonly idleMs: number;
  readonly absoluteMs: number;
}

/** What the configuration is read from: the linked secrets' values and the lifetimes' environment. */
export interface AuthSource {
  readonly username: string | undefined;
  readonly passwordHash: string | undefined;
  readonly sessionSecret: string | undefined;
  readonly idleDays: string | undefined;
  readonly absoluteDays: string | undefined;
}

export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

const days = (name: string, fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      if (!/^\d+$/.test(value) || parsed < 1 || parsed > 365) {
        context.addIssue({ code: 'custom', message: `${name} must be a whole number of days from 1 to 365` });
        return z.NEVER;
      }
      return parsed;
    });

/** Validates the configuration. Messages name a value, never print it. */
export function parseAuthConfig(source: AuthSource): AuthConfig {
  const username = source.username?.trim() ?? '';
  if (username === '') throw new AuthConfigError('The AdminUsername secret is empty.');
  const sessionSecret = source.sessionSecret ?? '';
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new AuthConfigError(`The SessionSecret secret is shorter than ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }
  const passwordHashValue = source.passwordHash?.trim() ?? '';
  const passwordHash = parsePasswordHash(passwordHashValue);
  if (passwordHash === null) {
    throw new AuthConfigError('The AdminPasswordHash secret is not a hash made by `npm run --silent auth:hash-password` (docs/deploy.md).');
  }
  const lifetimes = z
    .object({ idle: days(IDLE_DAYS_ENV, DEFAULT_IDLE_DAYS), absolute: days(ABSOLUTE_DAYS_ENV, DEFAULT_ABSOLUTE_DAYS) })
    .safeParse({ idle: source.idleDays, absolute: source.absoluteDays });
  if (!lifetimes.success) throw new AuthConfigError(lifetimes.error.issues.map((issue) => issue.message).join('; '));
  const { idle, absolute } = lifetimes.data;
  if (idle > absolute) throw new AuthConfigError(`${IDLE_DAYS_ENV} is longer than ${ABSOLUTE_DAYS_ENV}.`);
  return { username, passwordHashValue, passwordHash, sessionSecret, idleMs: idle * DAY_MS, absoluteMs: absolute * DAY_MS };
}

/** The deployed configuration: the linked secrets and the function's environment. */
export function deployedAuthSource(env: Readonly<Record<string, string | undefined>> = process.env): AuthSource {
  return {
    username: linkedValue('AdminUsername'),
    passwordHash: linkedValue('AdminPasswordHash'),
    sessionSecret: linkedValue('SessionSecret'),
    idleDays: env[IDLE_DAYS_ENV],
    absoluteDays: env[ABSOLUTE_DAYS_ENV],
  };
}

let cached: AuthConfig | undefined;

/** The deployed configuration, read once per server function instance. */
export function authConfig(): AuthConfig {
  cached ??= parseAuthConfig(deployedAuthSource());
  return cached;
}
