import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  assertSecretsSet,
  CONFIGURATION,
  DeploymentConfigError,
  readDeploymentConfig,
  SECRETS,
} from '../../infra/config';
import { markdownSection, readRepoFile } from '../support/repo-file';
import { installFakeSst, type FakeSst } from './fake-sst';
import { deploymentEnv, runStack, stackSources } from './harness';

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

const guide = readRepoFile('docs/deploy.md');
const secretNames = SECRETS.map(({ name }) => name);
const configNames = CONFIGURATION.map(({ name }) => name);

/** The names of the environment variables a composite action's steps read from the job. */
function hookEnvironmentReads(path: string): string[] {
  const action = parse(readRepoFile(path)) as { runs: { steps: { run?: string; with?: Record<string, string> }[] } };
  const text = action.runs.steps.map((step) => `${step.run ?? ''}\n${Object.values(step.with ?? {}).join('\n')}`).join('\n');
  return [...new Set([...text.matchAll(/\b(PLINTHOS_[A-Z0-9_]+|AWS_DEPLOY_ROLE_ARN)\b/g)].map((match) => match[1] ?? ''))];
}

describe('owner-specific values come from configuration', () => {
  it('[PLAT-2] a deploy without the region fails and names PLINTHOS_AWS_REGION', () => {
    expect(() => readDeploymentConfig({})).toThrow(DeploymentConfigError);
    expect(() => readDeploymentConfig({})).toThrow(/PLINTHOS_AWS_REGION/);
    expect(() => readDeploymentConfig({ PLINTHOS_AWS_REGION: '  ' })).toThrow(/PLINTHOS_AWS_REGION/);
    expect(() => readDeploymentConfig({ PLINTHOS_AWS_REGION: 'frankfurt' })).toThrow(/not an AWS region code/);
  });

  it('[PLAT-2] the region and the budget limit are read from the environment, the limit defaulting to $10', () => {
    expect(readDeploymentConfig({ PLINTHOS_AWS_REGION: 'us-west-2' })).toEqual({
      region: 'us-west-2',
      budgetLimitUsd: 10,
      auroraMaxAcu: 1,
      sessionIdleDays: 7,
      sessionAbsoluteDays: 30,
    });
    expect(readDeploymentConfig({ PLINTHOS_AWS_REGION: 'eu-west-1', PLINTHOS_BUDGET_LIMIT_USD: '25.50' })).toEqual({
      region: 'eu-west-1',
      budgetLimitUsd: 25.5,
      auroraMaxAcu: 1,
      sessionIdleDays: 7,
      sessionAbsoluteDays: 30,
    });
    for (const bad of ['0', '-5', 'ten', '1e3', '10.123']) {
      expect(() => readDeploymentConfig({ PLINTHOS_AWS_REGION: 'eu-west-1', PLINTHOS_BUDGET_LIMIT_USD: bad })).toThrow(
        /PLINTHOS_BUDGET_LIMIT_USD/,
      );
    }
  });

  it('[PLAT-2] [PLAT-8] Aurora’s maximum capacity is read from the environment, 1 ACU by default, within Aurora’s range', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    expect(readDeploymentConfig(region).auroraMaxAcu).toBe(1);
    expect(readDeploymentConfig({ ...region, PLINTHOS_AURORA_MAX_ACU: ' ' }).auroraMaxAcu).toBe(1);
    for (const [value, acu] of [['2', 2], ['2.5', 2.5], ['256', 256]] as const) {
      expect(readDeploymentConfig({ ...region, PLINTHOS_AURORA_MAX_ACU: value }).auroraMaxAcu).toBe(acu);
    }
    for (const bad of ['0', '0.5', '1.25', '257', 'one', '-1']) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_AURORA_MAX_ACU: bad }), bad).toThrow(/PLINTHOS_AURORA_MAX_ACU/);
    }
  });

  it('[PLAT-2] a deploy with any SST secret unset fails, naming each missing one with the command that sets it', () => {
    expect(() => assertSecretsSet(deploymentEnv())).not.toThrow();
    for (const name of secretNames) {
      const env = deploymentEnv({ [`SST_SECRET_${name}`]: '' });
      expect(() => assertSecretsSet(env)).toThrow(`npx sst secret set ${name} <value> --stage production`);
    }
    let message = '';
    try {
      assertSecretsSet({});
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of secretNames) expect(message).toContain(`npx sst secret set ${name} `);
  });

  it('[PLAT-2] the stack checks its secrets before it creates any resource or registers any guard', () => {
    const env = deploymentEnv({ SST_SECRET_AlertEmail: '' });
    expect(() => runStack(fake, env)).toThrow(/AlertEmail/);
    expect(fake.events).toEqual([]);
  });

  it('[PLAT-2] the stack declares every SST secret, and the alert address is the AlertEmail secret', () => {
    runStack(fake);
    expect(fake.ofType('sst:sst:Secret').map(({ name }) => name).sort()).toEqual([...secretNames].sort());
    const [subscription] = fake.ofType('aws:sns/topicSubscription:TopicSubscription');
    expect(subscription?.args.endpoint).toBe('fake-secret:AlertEmail');
  });

  it('[PLAT-2] the stack reads the environment only through infra/config.ts, and hard-codes no region', () => {
    for (const { path, source } of stackSources()) {
      if (path !== 'sst.config.ts') expect(source, path).not.toMatch(/process\.env/);
      expect(source, path).not.toMatch(/['"`](?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d['"`]/);
    }
  });
});

describe('docs/deploy.md', () => {
  it('[PLAT-3] names every SST secret with the exact line that sets it', () => {
    for (const name of secretNames) {
      expect(guide, name).toMatch(new RegExp(`^npx sst secret set ${name} \\S.* --stage production$`, 'm'));
      expect(guide, name).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
    }
  });

  it('[PLAT-3] names every configuration value with how to set it', () => {
    for (const name of configNames) {
      expect(guide, name).toMatch(new RegExp(`^export ${name}=\\S+$`, 'm'));
      expect(guide, name).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
    }
  });

  it('[PLAT-3] names every value the deploy hook reads from its environment', () => {
    const section = markdownSection(guide, 'The deploy lane').join('\n');
    for (const name of hookEnvironmentReads('.github/actions/deploy/action.yml')) {
      expect(section, name).toContain(`\`${name}\``);
    }
  });

  it('[PLAT-3] the stack reads no configuration value or secret that infra/config.ts does not list', () => {
    for (const { path, source } of stackSources()) {
      for (const [name] of source.matchAll(/\bPLINTHOS_[A-Z0-9_]+\b/g)) expect(configNames, `${path}: ${name}`).toContain(name);
      // A secret is declared in one place, from the list, and never by a name of its own.
      const declared = [...source.matchAll(/new\s+sst\.Secret\s*\(([^)]*)\)/g)].map((match) => match[1]);
      if (path === 'infra/stack.ts') expect(declared).toEqual(['name']);
      else expect(declared, path).toEqual([]);
      for (const [, name] of source.matchAll(/SST_SECRET_([A-Za-z0-9]+)/g)) expect(secretNames, `${path}: ${name}`).toContain(name);
    }
  });
});
