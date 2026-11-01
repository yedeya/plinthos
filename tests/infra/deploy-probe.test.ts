import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../support/repo-file';

// probe.sh, run against stand-ins for `curl` (GitHub's OIDC token endpoint) and `aws` (STS).
// The stand-in STS answers by the role ARN it is given, so each case picks its answer.
const PROBE = join(repoRoot, '.github/actions/deploy/probe.sh');
const ROLE = {
  refusing: 'arn:aws:iam::000000000000:role/refuses',
  trusting: 'arn:aws:iam::000000000000:role/trusts-everyone',
  broken: 'arn:aws:iam::000000000000:role/sts-unreachable',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plinthos-probe-'));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub('curl', `echo '{"value":"fake-oidc-token"}'`);
  stub(
    'aws',
    [
      'role=""; while [ $# -gt 0 ]; do [ "$1" = --role-arn ] && role="$2"; shift; done',
      `case "$role" in`,
      `  *refuses) echo "An error occurred (AccessDenied) when calling the AssumeRoleWithWebIdentity operation: Not authorized" >&2; exit 254 ;;`,
      `  *trusts-everyone) echo "AROAFAKE:kanon-deploy-probe"; exit 0 ;;`,
      `  *) echo "Could not connect to the endpoint URL" >&2; exit 255 ;;`,
      'esac',
    ].join('\n'),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function probe(env: Record<string, string>): Record<string, string> {
  execFileSync('bash', [PROBE], {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: dir,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example.test/?x=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-request-token',
      ...env,
    },
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(join(dir, 'kanon-deploy-probe.json'), 'utf8')) as Record<string, string>;
}

describe('the trust probe', () => {
  it('[PLAT-4] answers refused when STS refuses the production role outside its environment', () => {
    expect(probe({ ENVIRONMENTS: 'production', AWS_DEPLOY_ROLE_ARN: ROLE.refusing })).toEqual({ production: 'refused' });
  });

  it('[PLAT-4] answers obtained when the role hands out a credential outside its environment', () => {
    expect(probe({ ENVIRONMENTS: 'production', AWS_DEPLOY_ROLE_ARN: ROLE.trusting })).toEqual({ production: 'obtained' });
  });

  it('[PLAT-4] answers unconfigured with no role, with no OIDC token, or on any failure but a refusal', () => {
    expect(probe({ ENVIRONMENTS: 'production' })).toEqual({ production: 'unconfigured' });
    expect(probe({ ENVIRONMENTS: 'production', AWS_DEPLOY_ROLE_ARN: ROLE.broken })).toEqual({ production: 'unconfigured' });
    expect(
      probe({ ENVIRONMENTS: 'production', AWS_DEPLOY_ROLE_ARN: ROLE.refusing, ACTIONS_ID_TOKEN_REQUEST_URL: '' }),
    ).toEqual({ production: 'unconfigured' });
  });

  it('[PLAT-4] answers for every listed environment, and knows no role but production’s', () => {
    expect(probe({ ENVIRONMENTS: 'staging production', AWS_DEPLOY_ROLE_ARN: ROLE.refusing })).toEqual({
      staging: 'unconfigured',
      production: 'refused',
    });
  });
});
