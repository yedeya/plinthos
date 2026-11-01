/**
 * `signIn`, the typed service function behind the login (`AGENTS.md` §4, [AUTH-2], [AUTH-12]).
 *
 * In this order: count the attempt against the configured limits (`./rate-limit.ts`) and refuse
 * it, unchecked, when a limit is reached; validate the input; compare the username and the password with the deployment's
 * configuration, in constant time, without the database; and only after both match, start a
 * session, which is the first and only database call. A wrong username still runs scrypt, so the
 * answer's timing does not say which of the two was wrong.
 *
 * The password is never logged or returned. Each outcome logs one `businessEvent`:
 * `auth.login.succeeded`, `auth.login.failed` or `auth.login.rate_limited`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { logger, type Logger } from '../logger';
import { authConfig } from './config';
import { loginAttemptCounter } from './login-attempts';
import { verifyPassword } from './password';
import { countLoginAttempt } from './rate-limit';
import { startSession, type NewSession } from './sessions';

export const SignInInput = z.object({
  username: z.string().max(256),
  password: z.string().min(1).max(1024),
  /** Where the attempt came from, as the route reads it: the limiter's key. */
  clientAddress: z.string().max(256),
});
export type SignInInput = z.input<typeof SignInInput>;

export type SignInResult =
  | ({ readonly outcome: 'signed-in' } & NewSession)
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number };

function sameText(given: string, expected: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export async function signIn(input: SignInInput, options: { readonly log?: Logger; readonly requestId?: string } = {}): Promise<SignInResult> {
  const log = options.log ?? logger;
  const fields = { requestId: options.requestId };
  const clientAddress = typeof input?.clientAddress === 'string' ? input.clientAddress.slice(0, 256) : 'unknown';

  const config = authConfig();
  const decision = await countLoginAttempt(clientAddress, loginAttemptCounter(), Date.now(), config.loginLimits);
  if (!decision.allowed) {
    log.warn({ businessEvent: 'auth.login.rate_limited', scope: decision.scope, ...fields }, 'a login attempt was refused: too many attempts');
    return { outcome: 'rate-limited', retryAfterSeconds: decision.retryAfterSeconds };
  }

  const parsed = SignInInput.safeParse(input);
  const usernameMatches = parsed.success && sameText(parsed.data.username.trim(), config.username);
  // scrypt runs whether or not the username matched.
  const passwordMatches = parsed.success && (await verifyPassword(parsed.data.password, config.passwordHash));
  if (!usernameMatches || !passwordMatches) {
    log.info({ businessEvent: 'auth.login.failed', ...fields }, 'a login attempt failed');
    return { outcome: 'refused' };
  }

  const session = await startSession();
  log.info({ businessEvent: 'auth.login.succeeded', ...fields }, 'the admin signed in');
  return { outcome: 'signed-in', ...session };
}
