import { describe, expect, it } from 'vitest';
import { AuthConfigError, ATTEMPTS_PER_ADDRESS_ENV, ATTEMPTS_TOTAL_ENV, deployedAuthSource } from '../../../src/server/auth/config';
import { LOGIN_LIMITS } from '../../../src/server/auth/rate-limit';
import { testAuthConfig } from '../../support/auth';

describe('the login limits’ configuration', () => {
  it('[AUTH-13] defaults to 10 attempts per address and 100 in total, in 15-minute windows', async () => {
    expect((await testAuthConfig()).loginLimits).toEqual({ windowSeconds: 15 * 60, perAddress: 10, total: 100 });
    expect((await testAuthConfig({ attemptsPerAddress: ' ', attemptsTotal: '' })).loginLimits).toEqual(LOGIN_LIMITS);
  });

  it('[AUTH-13] takes both limits from the function’s environment', async () => {
    const source = deployedAuthSource({ [ATTEMPTS_PER_ADDRESS_ENV]: '5', [ATTEMPTS_TOTAL_ENV]: '400' });
    expect(source).toMatchObject({ attemptsPerAddress: '5', attemptsTotal: '400' });
    expect((await testAuthConfig({ attemptsPerAddress: '5', attemptsTotal: '400' })).loginLimits).toEqual({
      windowSeconds: LOGIN_LIMITS.windowSeconds,
      perAddress: 5,
      total: 400,
    });
  });

  it('[AUTH-13] refuses a limit that is not a positive whole number, naming it', async () => {
    for (const bad of ['0', '-1', '1.5', 'ten', '1e3']) {
      await expect(testAuthConfig({ attemptsPerAddress: bad }), bad).rejects.toThrow(AuthConfigError);
      await expect(testAuthConfig({ attemptsPerAddress: bad }), bad).rejects.toThrow(ATTEMPTS_PER_ADDRESS_ENV);
      await expect(testAuthConfig({ attemptsTotal: bad }), bad).rejects.toThrow(ATTEMPTS_TOTAL_ENV);
    }
  });

  it('[AUTH-13] refuses a per-address limit that is not below the total, so one address can’t use the whole total', async () => {
    await expect(testAuthConfig({ attemptsPerAddress: '100', attemptsTotal: '100' })).rejects.toThrow(AuthConfigError);
    await expect(testAuthConfig({ attemptsPerAddress: '20', attemptsTotal: '10' })).rejects.toThrow(ATTEMPTS_PER_ADDRESS_ENV);
    expect((await testAuthConfig({ attemptsPerAddress: '99', attemptsTotal: '100' })).loginLimits.perAddress).toBe(99);
  });
});
