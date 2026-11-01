import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseAuthConfig, AuthConfigError } from '../../../src/server/auth/config';
import { DEFAULT_PARAMETERS, hashPassword, parsePasswordHash, verifyPassword } from '../../../src/server/auth/password';
import { readRepoFile, repoRoot } from '../../support/repo-file';
import { TEST_PASSWORD, TEST_SESSION_SECRET, TEST_USERNAME, testHash } from '../../support/auth';

function parse(hash: string) {
  const parsed = parsePasswordHash(hash);
  if (parsed === null) throw new Error('not a hash this module makes');
  return parsed;
}

const FORMAT = /^scrypt:ln=\d+,r=\d+,p=\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

describe('the password hash', () => {
  it('[AUTH-2] is scrypt with its parameters stored beside it, and checks the right password only', async () => {
    const hash = await testHash();
    expect(hash).toMatch(FORMAT);
    expect(hash).not.toContain(TEST_PASSWORD);
    const parsed = parse(hash);
    expect(parsed).toMatchObject({ ln: 10, r: 8, p: 1 });
    expect(await verifyPassword(TEST_PASSWORD, parsed)).toBe(true);
    expect(await verifyPassword(`${TEST_PASSWORD}x`, parsed)).toBe(false);
    expect(await verifyPassword('', parsed)).toBe(false);
  });

  it('[AUTH-2] makes a fresh salt each time, and defaults to a memory-hard cost of at least 128 MiB', async () => {
    expect(await testHash()).not.toBe(await testHash());
    expect(128 * 2 ** DEFAULT_PARAMETERS.ln * DEFAULT_PARAMETERS.r).toBeGreaterThanOrEqual(128 * 1024 * 1024);
  });

  it('[AUTH-2] compares the derived key in constant time', () => {
    const source = readRepoFile('src/server/auth/password.ts');
    expect(source).toMatch(/timingSafeEqual\(key, hash\.key\)/);
    expect(source).not.toMatch(/key\.equals|===\s*hash\.key|toString\([^)]*\)\s*===/);
  });

  it('[AUTH-2] refuses a malformed hash, or one whose parameters are out of bounds', async () => {
    const good = await testHash();
    for (const bad of ['', 'plain-text', good.replace('scrypt:', 'bcrypt:'), good.replace('ln=10', 'ln=30'), good.replace('ln=10', 'ln=4'), good.replace('r=8', 'r=0')]) {
      expect(parsePasswordHash(bad), bad).toBeNull();
    }
  });

  it('[AUTH-2] is read from configuration, which refuses an invalid hash or a short session secret without printing either', async () => {
    const source = { username: TEST_USERNAME, passwordHash: await testHash(), sessionSecret: TEST_SESSION_SECRET, idleDays: undefined, absoluteDays: undefined };
    expect(parseAuthConfig(source).username).toBe(TEST_USERNAME);
    expect(() => parseAuthConfig({ ...source, passwordHash: 'made-up-not-a-hash' })).toThrow(AuthConfigError);
    expect(() => parseAuthConfig({ ...source, passwordHash: 'made-up-not-a-hash' })).not.toThrow(/made-up-not-a-hash/);
    expect(() => parseAuthConfig({ ...source, sessionSecret: 'short-made-up' })).toThrow(/SessionSecret/);
    expect(() => parseAuthConfig({ ...source, sessionSecret: 'short-made-up' })).not.toThrow(/short-made-up/);
    expect(() => parseAuthConfig({ ...source, username: ' ' })).toThrow(/AdminUsername/);
  });

  it('[AUTH-2] round-trips a hash made at the default cost', async () => {
    const hash = await hashPassword(TEST_PASSWORD);
    expect(hash.startsWith(`scrypt:ln=${DEFAULT_PARAMETERS.ln},r=${DEFAULT_PARAMETERS.r},p=${DEFAULT_PARAMETERS.p}:`)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, parse(hash))).toBe(true);
  });
});

describe('npm run auth:hash-password', () => {
  const run = (input: string) =>
    spawnSync('npx', ['tsx', 'scripts/hash-password.ts'], { cwd: repoRoot, input, encoding: 'utf8' });

  it('[AUTH-2] prints only the hash of the password it reads, never the password', async () => {
    const result = run(`${TEST_PASSWORD}\n`);
    expect(result.status, result.stderr).toBe(0);
    const hash = result.stdout.trim();
    expect(result.stdout).toBe(`${hash}\n`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(TEST_PASSWORD);
    expect(await verifyPassword(TEST_PASSWORD, parse(hash))).toBe(true);
    // No character a shell would expand, so the secret can be set as it is.
    expect(hash).not.toMatch(/[$`"'\\!*?\s]/);
  });

  it('[AUTH-2] refuses a short password and prints nothing on standard output', () => {
    const result = run('made-up\n');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/shorter than/);
  });
});
