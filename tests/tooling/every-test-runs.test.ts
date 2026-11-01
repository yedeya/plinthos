import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../support/repo-file';

// Each way to leave a test out at runtime, or past the lint gate, keyed by the name it gives the
// test that `npm test` must report. The module lives outside the repository, so neither the lint
// gate nor the project's own run ever sees it.
const LEFT_OUT = {
  'skipped with ctx.skip()': "it('skipped with ctx.skip()', (ctx) => { ctx.skip(); });",
  'skipped with a destructured skip()': "it('skipped with a destructured skip()', ({ skip }) => { skip(); });",
  'skipped through an aliased it': "check.skip('skipped through an aliased it', () => {});",
  'skipped with it.concurrent.skip': "it.concurrent.skip('skipped with it.concurrent.skip', () => {});",
  'left as test.todo': "test.todo('left as test.todo');",
  'skipped with suite.skip': "suite.skip('skipped with suite.skip', () => { it('runs', () => {}); });",
  'left as describe.todo': "describe.todo('left as describe.todo');",
};

const sandbox = mkdtempSync(join(tmpdir(), 'plinthos-every-test-runs-'));
symlinkSync(join(repoRoot, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
mkdirSync(join(sandbox, 'tests'));

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

/** Runs `vitest run` with the project's own configuration over one test module in the sandbox. */
function runProjectVitest(source: string[], args: string[] = []): { status: number | null; output: string } {
  writeFileSync(join(sandbox, 'tests', 'example.test.ts'), source.join('\n'));
  // The worker's own VITEST_* variables would tell the nested run it is already inside a worker.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(repoRoot, 'vitest.config.ts'), '--root', sandbox, ...args],
    { cwd: sandbox, env: { ...env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const HEADER = ["import { describe, it, suite, test } from 'vitest';", "import { it as check } from 'vitest';", "it('runs', () => {});"];

/** The lines of `source` the lint gate refuses as leaving a test out, linted as a test module. */
async function linesRefused(source: string[]): Promise<number[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source.join('\n'), { filePath: join(repoRoot, 'tests/example.test.ts') });
  return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax').map((message) => message.line);
}

describe('npm run lint', () => {
  it('[DEV-3] refuses every static way to skip or focus a test that it claims to', async () => {
    const source = [
      "import { afterEach, beforeEach, describe, it, suite, test } from 'vitest';",
      "it.skip('a', () => {});",
      "test.skipIf(true)('b', () => {});",
      "describe.runIf(false)('c', () => {});",
      "it.todo('d');",
      "it.only('e', () => {});",
      "suite.skip('f', () => {});",
      "suite.todo('g');",
      "it.concurrent.skip('h', () => {});",
      "test.sequential.skipIf(true)('i', () => {});",
      "describe.sequential.concurrent.only('j', () => {});",
      "import { it as check } from 'vitest';",
      "import { describe as group, test as example, suite as section } from 'vitest';",
      "import * as vitest from 'vitest';",
      "it('k', (ctx) => { ctx.skip(); });",
      "it('l', ({ skip }) => { skip(); });",
      "test.concurrent('m', (context) => { context.skip(true, 'not yet'); });",
      "beforeEach((ctx) => { ctx.skip(); });",
      "afterEach(({ skip }) => skip());",
      '',
    ];
    // The `import { describe as group, … }` line renames three, so the gate reports it three times.
    expect(await linesRefused(source)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('leaves unrelated skip properties alone', async () => {
    const source = [
      "import { expect as want, it } from 'vitest';",
      'const page = { skip: 10, limit: 5 };',
      'const { skip } = page;',
      'export const offset = page.skip + skip;',
      'export const rest = [1, 2, 3].slice(page.skip);',
      'export function list({ limit }: { limit: number }) { return limit; }',
      'export const lines = { skip: (n: number) => n };',
      'lines.skip(1);',
      "it('runs', () => { want(page.skip).toBe(10); });",
      '',
    ];
    expect(await linesRefused(source)).toEqual([]);
  });
});

describe('npm test', () => {
  it('[DEV-3] fails when any test is skipped or left as todo, however it was left out', () => {
    const { status, output } = runProjectVitest([...HEADER, ...Object.values(LEFT_OUT), '']);
    expect(status, output).toBe(1);
    for (const name of Object.keys(LEFT_OUT)) expect(output).toContain(name);
  }, 60_000);

  it('passes when every test runs', () => {
    const { status, output } = runProjectVitest([...HEADER, '']);
    expect(status, output).toBe(0);
  }, 60_000);

  it('leaves a run filtered by test name alone: the filter, not the test, left the others out', () => {
    const { status, output } = runProjectVitest([...HEADER, ...Object.values(LEFT_OUT), ''], ['-t', '^runs$']);
    expect(status, output).toBe(0);
  }, 60_000);
});
