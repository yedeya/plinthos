import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readRepoFile } from '../support/repo-file';

// The smoke hook's check, run as GitHub runs a composite `shell: bash` step, against stand-ins
// for `curl`, `sleep` and `date` that share a fake clock. A stand-in `curl` spends the
// `--max-time` it is given when the admin doesn't answer, and `sleep` spends its argument, so
// the clock reads how long the real check would have waited, without waiting.
const START = 1_000_000;

let dir: string;
const clock = () => Number(readFileSync(join(dir, 'clock'), 'utf8'));
const events = () => readFileSync(join(dir, 'events'), 'utf8').trim().split('\n');

function stub(name: string, body: string) {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** A stand-in `curl` that logs its timeout, then runs `answer` with that timeout in `$limit`. */
function curl(answer: string) {
  stub(
    'curl',
    [
      'limit=""; while [ $# -gt 0 ]; do [ "$1" = --max-time ] && limit="$2"; shift; done',
      `echo "curl $limit" >> "${dir}/events"`,
      `n=$(( $(cat "${dir}/attempts") + 1 )); echo "$n" > "${dir}/attempts"`,
      answer,
    ].join('\n'),
  );
}
/** The answer of an admin that never responds: the attempt spends its whole timeout. */
const timesOut = () => `echo $(( $(cat "${dir}/clock") + limit )) > "${dir}/clock"; exit 28`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plinthos-smoke-'));
  writeFileSync(join(dir, 'clock'), String(START));
  writeFileSync(join(dir, 'events'), '');
  writeFileSync(join(dir, 'attempts'), '0');
  writeFileSync(join(dir, 'plinthos-admin-url'), 'https://admin.example.test/\n');
  stub('date', `cat "${dir}/clock"`);
  stub('sleep', `echo "sleep $1" >> "${dir}/events"; echo $(( $(cat "${dir}/clock") + $1 )) > "${dir}/clock"`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function smoke() {
  const action = parse(readRepoFile('.github/actions/smoke/action.yml')) as { runs: { steps: { run: string }[] } };
  const script = join(dir, 'smoke.sh');
  writeFileSync(script, action.runs.steps[0]?.run ?? '');
  // GitHub runs a `shell: bash` step as `bash --noprofile --norc -eo pipefail {0}`.
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, RUNNER_TEMP: dir },
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('the smoke hook', () => {
  it('[PLAT-4] fails the deploy within five minutes when /health/live never answers', () => {
    curl(timesOut());
    const { status, output } = smoke();
    expect(status).toBe(1);
    expect(output).toContain('::error file=.github/actions/smoke/action.yml::/health/live did not answer 200 within five minutes');
    expect(clock() - START).toBeLessThanOrEqual(300);
    // It spends the five minutes trying, and doesn't pause after the last attempt.
    expect(clock() - START).toBeGreaterThanOrEqual(290);
    expect(events().at(-1)).toMatch(/^curl /);
    // No attempt's timeout reaches past the deadline.
    for (const event of events()) expect(event).toMatch(/^(curl ([1-9]|10)|sleep 10)$/);
  });

  it('[PLAT-4] fails the deploy within five minutes when /health/live answers anything but 200', () => {
    curl(`printf 'busy\\n503'`);
    const { status, output } = smoke();
    expect(status).toBe(1);
    expect(output).toContain('attempt 1: /health/live answered 503');
    expect(output).toContain('/health/live did not answer 200 within five minutes');
    expect(clock() - START).toBeLessThanOrEqual(300);
    expect(events().at(-1)).toMatch(/^curl /);
  });

  it('[PLAT-4] cuts the last attempt short at the deadline when less than ten seconds are left', () => {
    // Each attempt spends three seconds on a 503, so attempts start 13 s apart: after the 23rd,
    // 11 s are left, the check pauses, and the 24th starts with 1 s left.
    curl(`t=$(( limit < 3 ? limit : 3 )); echo $(( $(cat "${dir}/clock") + t )) > "${dir}/clock"; printf 'busy\\n503'`);
    const { status } = smoke();
    expect(status).toBe(1);
    expect(events().at(-1)).toBe('curl 1');
    expect(clock() - START).toBeLessThanOrEqual(300);
  });

  it('[PLAT-4] passes the deploy once /health/live answers 200 with {"status":"ok"}', () => {
    curl(`if [ "$n" -lt 3 ]; then ${timesOut()}; fi; printf '{"status":"ok"}\\n200'`);
    const { status, output } = smoke();
    expect(status).toBe(0);
    expect(output).toContain('/health/live answered 200 on attempt 3');
  });
});
