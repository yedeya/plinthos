import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { readDatabaseUrl } from '../../src/db/database-url';
import { auroraPostgresMajor } from '../support/aurora';
import { connectTestDatabase } from '../support/database';
import { repoRoot } from '../support/repo-file';

describe('the test database', () => {
  it('[DEV-3] a test that needs the database fails when DATABASE_URL is unset or empty', () => {
    expect(() => readDatabaseUrl({})).toThrow(/DATABASE_URL is unset/);
    expect(() => readDatabaseUrl({ DATABASE_URL: '  ' })).toThrow(/DATABASE_URL is unset/);
    expect(readDatabaseUrl({ DATABASE_URL: 'postgres://u:p@localhost:5432/d' })).toBe('postgres://u:p@localhost:5432/d');
  });

  it('[DEV-3] a test that needs the database fails when the database does not answer', async () => {
    // Port 9 is the discard service, which nothing on a runner serves, so the connection is refused.
    await expect(connectTestDatabase('postgres://plinthos:plinthos@127.0.0.1:9/plinthos')).rejects.toThrow(
      /does not answer/,
    );
  });

  it('[DEV-3] no test can be skipped or focused: the lint gate refuses it', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const source = [
      "import { describe, it, test } from 'vitest';",
      "it.skip('a', () => {});",
      "test.skipIf(true)('b', () => {});",
      "describe.runIf(false)('c', () => {});",
      "it.todo('d');",
      "it.only('e', () => {});",
      '',
    ].join('\n');
    const [result] = await eslint.lintText(source, { filePath: `${repoRoot}tests/example.test.ts` });
    const restricted = (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-properties');
    expect(restricted.map((message) => message.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it('[DEV-4] answers at DATABASE_URL and runs the Aurora engine\'s PostgreSQL major version', async () => {
    const client = await connectTestDatabase();
    try {
      const { rows } = await client.query<{ server_version_num: string }>('show server_version_num');
      expect(Math.floor(Number(rows[0]?.server_version_num) / 10_000)).toBe(auroraPostgresMajor());
    } finally {
      await client.end();
    }
  });
});
