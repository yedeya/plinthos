import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cameThroughCloudFront, ORIGIN_HEADER, originSecret } from '../../../src/server/auth/via-cloudfront';
import { TEST_SESSION_SECRET } from '../../support/auth';

const headers = (values: Record<string, string>) => new Headers(values);

describe('the check that a request came through CloudFront', () => {
  it('[AUTH-14] derives the origin header’s value from the session secret, one-way, and a new session secret changes it', () => {
    const value = originSecret(TEST_SESSION_SECRET);
    expect(value).toBe(createHmac('sha256', TEST_SESSION_SECRET).update('plinthos.origin.v1').digest('base64url'));
    expect(value).not.toContain(TEST_SESSION_SECRET);
    // A header value CloudFront Functions can carry, quoted, without escaping.
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(originSecret(`${TEST_SESSION_SECRET}-rotated`)).not.toBe(value);
  });

  it('[AUTH-14] lets through only a request that carries exactly that value', () => {
    const value = originSecret(TEST_SESSION_SECRET);
    expect(cameThroughCloudFront(headers({ [ORIGIN_HEADER]: value }), TEST_SESSION_SECRET)).toBe(true);
    const refused: Record<string, string>[] = [
      {},
      { [ORIGIN_HEADER]: '' },
      { [ORIGIN_HEADER]: value.slice(0, -1) },
      { [ORIGIN_HEADER]: `${value}x` },
      { [ORIGIN_HEADER]: `${value}, ${value}` },
      { [ORIGIN_HEADER]: value.toUpperCase() },
      { [ORIGIN_HEADER]: originSecret(`${TEST_SESSION_SECRET}-rotated`) },
      { [ORIGIN_HEADER]: TEST_SESSION_SECRET },
      { 'x-plinthos-origin-other': value },
    ];
    for (const bad of refused) expect(cameThroughCloudFront(headers(bad), TEST_SESSION_SECRET), JSON.stringify(bad)).toBe(false);
  });
});
