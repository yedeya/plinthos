import { describe, expect, it } from 'vitest';
import {
  asCatalogueToken,
  generateCatalogueToken,
  InvalidCatalogueTokenError,
  isCatalogueToken,
  TOKEN_BYTES,
} from '../../../src/server/publish/token';
import { readRepoFile } from '../../support/repo-file';

/** `[PUB-7]`: the catalogue token holds at least 128 bits from a secure generator and is URL-safe. */

describe('the catalogue token', () => {
  it('[PUB-7] holds at least 128 bits: 32 bytes, 256 bits, decoded back from what is stored', () => {
    expect(TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
    const token = generateCatalogueToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(TOKEN_BYTES);
    expect(Buffer.from(token, 'base64url').toString('base64url')).toBe(token);
  });

  it('[PUB-7] comes from node:crypto’s secure generator, never Math.random', () => {
    const source = readRepoFile('src/server/publish/token.ts');
    expect(source).toMatch(/import \{ randomBytes \} from 'node:crypto';/);
    expect(source).toContain('randomBytes(TOKEN_BYTES)');
    expect(source).not.toMatch(/Math\.random/);
  });

  it('[PUB-7] is URL-safe as it is: it survives encodeURIComponent unchanged', () => {
    for (let index = 0; index < 200; index += 1) {
      const token = generateCatalogueToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it('[PUB-7] does not repeat: a thousand tokens are a thousand distinct ones', () => {
    expect(new Set(Array.from({ length: 1000 }, generateCatalogueToken)).size).toBe(1000);
  });

  it('[PUB-7] refuses a stored value of any other shape, without echoing it', () => {
    for (const bad of [null, '', 'short', '../../escape', `${'a'.repeat(42)}/`, `${'a'.repeat(44)}`, 'a'.repeat(42) + '=']) {
      expect(isCatalogueToken(bad), String(bad)).toBe(false);
      expect(() => asCatalogueToken(bad)).toThrow(InvalidCatalogueTokenError);
    }
    const refusal = (() => {
      try {
        asCatalogueToken('../../escape');
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(refusal).not.toBe('');
    expect(refusal).not.toContain('escape');
    const token = generateCatalogueToken();
    expect(asCatalogueToken(token)).toBe(token);
  });
});
