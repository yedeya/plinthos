import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { addressKey, countLoginAttempt, dynamoCounter, LOGIN_LIMITS } from '../../../src/server/auth/rate-limit';
import { readRepoFile } from '../../support/repo-file';
import { memoryCounter } from '../../support/auth';

const start = Date.UTC(2026, 10, 1, 12, 0, 0);

describe('the login rate limit', () => {
  it('[AUTH-12] refuses an address past its limit until the window has passed, and says how long to wait', async () => {
    const counter = memoryCounter();
    for (let i = 0; i < LOGIN_LIMITS.perAddress; i++) {
      expect(await countLoginAttempt('192.0.2.1', counter, start + i * 1000)).toEqual({ allowed: true });
    }
    const refused = await countLoginAttempt('192.0.2.1', counter, start + 60_000);
    expect(refused).toMatchObject({ allowed: false, scope: 'address' });
    expect(refused.allowed === false && refused.retryAfterSeconds).toBe(LOGIN_LIMITS.windowSeconds - 60);
    // Another address is still let through, and the same one is after the window.
    expect(await countLoginAttempt('192.0.2.2', counter, start + 60_000)).toEqual({ allowed: true });
    expect(await countLoginAttempt('192.0.2.1', counter, start + LOGIN_LIMITS.windowSeconds * 1000)).toEqual({ allowed: true });
  });

  it('[AUTH-12] refuses every address once the total passes its limit', async () => {
    const counter = memoryCounter();
    for (let i = 0; i < LOGIN_LIMITS.total; i++) await countLoginAttempt(`198.51.100.${i % 250}-${i}`, counter, start);
    expect(await countLoginAttempt('203.0.113.9', counter, start)).toMatchObject({ allowed: false, scope: 'total' });
  });

  it('[AUTH-13] does not let one address use up the total: an attempt past its own limit is not counted in the total', async () => {
    const counter = memoryCounter();
    for (let i = 0; i <= LOGIN_LIMITS.total; i++) await countLoginAttempt('192.0.2.66', counter, start + i * 1000);
    expect(await countLoginAttempt('192.0.2.66', counter, start + 200_000)).toMatchObject({ allowed: false, scope: 'address' });
    expect([...counter.counts].filter(([key]) => key.startsWith('total#')).map(([, count]) => count)).toEqual([LOGIN_LIMITS.perAddress]);
    expect(await countLoginAttempt('203.0.113.9', counter, start + 200_000)).toEqual({ allowed: true });
  });

  it('[AUTH-12] still refuses every address once enough addresses, each within its own limit, pass the total', async () => {
    const counter = memoryCounter();
    const addresses = LOGIN_LIMITS.total / LOGIN_LIMITS.perAddress;
    for (let a = 0; a < addresses; a++) {
      for (let i = 0; i < LOGIN_LIMITS.perAddress; i++) {
        expect(await countLoginAttempt(`198.51.100.${a}`, counter, start)).toEqual({ allowed: true });
      }
    }
    expect(await countLoginAttempt('203.0.113.9', counter, start)).toMatchObject({ allowed: false, scope: 'total' });
  });

  it('[AUTH-12] [AUTH-13] counts against the limits it is given', async () => {
    const counter = memoryCounter();
    const limits = { windowSeconds: LOGIN_LIMITS.windowSeconds, perAddress: 2, total: 3 };
    for (let i = 0; i < 2; i++) expect(await countLoginAttempt('192.0.2.1', counter, start, limits)).toEqual({ allowed: true });
    expect(await countLoginAttempt('192.0.2.1', counter, start, limits)).toMatchObject({ allowed: false, scope: 'address' });
    expect(await countLoginAttempt('192.0.2.2', counter, start, limits)).toEqual({ allowed: true });
    expect(await countLoginAttempt('192.0.2.3', counter, start, limits)).toMatchObject({ allowed: false, scope: 'total' });
  });

  it('[AUTH-12] stores an address only as its hash', async () => {
    const counter = memoryCounter();
    await countLoginAttempt('192.0.2.77', counter, start);
    expect(counter.calls.join(' ')).not.toContain('192.0.2.77');
    expect(counter.calls[0]).toContain(addressKey('192.0.2.77'));
  });

  it('[AUTH-12] keeps its state in DynamoDB, one atomic update per count, with an expiry the TTL reads (tests/infra/auth.test.ts names the same attribute)', async () => {
    const sent: UpdateItemCommand[] = [];
    const counter = dynamoCounter('made-up-table', {
      send: async (command) => {
        sent.push(command);
        return { Attributes: { attempts: { N: '3' } } };
      },
    });
    expect(await counter.increment('total#1', 1_800_000_000)).toBe(3);
    const [command] = sent;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command?.input).toMatchObject({
      TableName: 'made-up-table',
      Key: { pk: { S: 'total#1' } },
      UpdateExpression: 'ADD attempts :one SET expiresAt = if_not_exists(expiresAt, :expiresAt)',
      ExpressionAttributeValues: { ':one': { N: '1' }, ':expiresAt': { N: '1800000000' } },
      ReturnValues: 'UPDATED_NEW',
    });
  });

  it('[AUTH-12] fails an attempt it could not count, rather than letting it through', async () => {
    const counter = dynamoCounter('made-up-table', { send: async () => ({}) });
    await expect(counter.increment('total#1', 1)).rejects.toThrow(/without a count/);
    const down = dynamoCounter('made-up-table', {
      send: async () => {
        throw new Error('made-up outage');
      },
    });
    await expect(countLoginAttempt('192.0.2.1', down, start)).rejects.toThrow('made-up outage');
  });

  it('[AUTH-12] gives every call to DynamoDB a timeout and the SDK’s backoff', () => {
    const source = readRepoFile('src/server/auth/rate-limit.ts');
    expect(source).toMatch(/requestTimeout: DYNAMO_TIMEOUT_MS/);
    expect(source).toMatch(/maxAttempts: DYNAMO_MAX_ATTEMPTS/);
  });
});
