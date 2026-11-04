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
      loginAttemptsPerAddress: 10,
      loginAttemptsTotal: 100,
      photoLongestEdge: 2048,
      photoMaxBytes: 4194304,
      partsMaxBytes: 20971520,
      currency: 'EUR',
      domain: undefined,
    });
    expect(readDeploymentConfig({ PLINTHOS_AWS_REGION: 'eu-west-1', PLINTHOS_BUDGET_LIMIT_USD: '25.50' })).toEqual({
      region: 'eu-west-1',
      budgetLimitUsd: 25.5,
      auroraMaxAcu: 1,
      sessionIdleDays: 7,
      sessionAbsoluteDays: 30,
      loginAttemptsPerAddress: 10,
      loginAttemptsTotal: 100,
      photoLongestEdge: 2048,
      photoMaxBytes: 4194304,
      partsMaxBytes: 20971520,
      currency: 'EUR',
      domain: undefined,
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

  it('[PLAT-2] [VAL-2] the currency is read from the environment, EUR by default, and must be an ISO 4217 code', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    expect(readDeploymentConfig(region).currency).toBe('EUR');
    expect(readDeploymentConfig({ ...region, PLINTHOS_CURRENCY: ' ' }).currency).toBe('EUR');
    expect(readDeploymentConfig({ ...region, PLINTHOS_CURRENCY: ' USD ' }).currency).toBe('USD');
    for (const bad of ['eur', 'EURO', 'E1R', '€', 'EU']) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_CURRENCY: bad }), bad).toThrow(/PLINTHOS_CURRENCY/);
    }
  });

  it('[PLAT-17] [PLAT-2] the domain is optional, with no fallback: unset or blank, the deployment has none', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    const setting = CONFIGURATION.find(({ name }) => name === 'PLINTHOS_DOMAIN');
    expect(setting).toMatchObject({ required: false });
    expect(setting).not.toHaveProperty('fallback');
    expect(readDeploymentConfig(region).domain).toBeUndefined();
    for (const value of ['', ' ', '\t']) expect(readDeploymentConfig({ ...region, PLINTHOS_DOMAIN: value }).domain, JSON.stringify(value)).toBeUndefined();
  });

  it('[PLAT-17] a domain is trimmed and lowercased, and any hostname of two labels or more fits', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    const label63 = `a${'b'.repeat(61)}c`;
    // 243 characters in all: four labels of 60 and three dots.
    const longest = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(60)).join('.');
    expect(longest).toHaveLength(243);
    for (const [value, domain] of [
      ['plinthos.example.com', 'plinthos.example.com'],
      ['  Plinthos.Example.COM ', 'plinthos.example.com'],
      ['example.com', 'example.com'],
      ['a.b', 'a.b'],
      ['my-bricks.example.co.uk', 'my-bricks.example.co.uk'],
      ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
      ['0.example.com', '0.example.com'],
      [`${label63}.example.com`, `${label63}.example.com`],
      [longest, longest],
      // Under neither of AWS's own names, only ending like them.
      ['notcloudfront.net', 'notcloudfront.net'],
      ['amazonaws.com.example.org', 'amazonaws.com.example.org'],
    ] as const) {
      expect(readDeploymentConfig({ ...region, PLINTHOS_DOMAIN: value }).domain, value).toBe(domain);
    }
  });

  it('[PLAT-17] refuses a domain that is not a hostname, naming PLINTHOS_DOMAIN', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    const label64 = 'a'.repeat(64);
    const tooLong = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(60)).join('.') + 'e';
    expect(tooLong).toHaveLength(244);
    for (const bad of [
      'example', // one label
      'localhost',
      'https://plinthos.example.com', // a scheme
      '//plinthos.example.com',
      'plinthos.example.com:443', // a port
      'plinthos.example.com/admin', // a path
      'plinthos.example.com/',
      'plinthos.example.com?x=1',
      '*.example.com', // a wildcard
      'plinthos.example.com.', // a trailing dot
      '.example.com', // an empty label
      'plinthos..example.com',
      '-plinthos.example.com', // a hyphen at either end of a label
      'plinthos-.example.com',
      'plinthos.example.-com',
      'plin_thos.example.com', // not a letter, digit or hyphen
      'plinthos example.com',
      'plinthös.example.com',
      'admin@plinthos.example.com',
      `${label64}.example.com`, // a label of 64
      tooLong, // 244 characters, so `catalogue.` would not fit before it
    ]) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_DOMAIN: bad }), bad).toThrow(DeploymentConfigError);
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_DOMAIN: bad }), bad).toThrow(/^PLINTHOS_DOMAIN is .* not a hostname such as plinthos\.example\.com/);
    }
  });

  it('[PLAT-17] refuses a domain under cloudfront.net or amazonaws.com, which no deployment can delegate', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    for (const bad of ['cloudfront.net', 'd111111abcdef8.cloudfront.net', 'CloudFront.NET', 'amazonaws.com', 'plinthos.s3.amazonaws.com', ' x.AMAZONAWS.com ']) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_DOMAIN: bad }), bad).toThrow(DeploymentConfigError);
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_DOMAIN: bad }), bad).toThrow(/^PLINTHOS_DOMAIN is .* under (cloudfront\.net|amazonaws\.com)/);
    }
  });

  it('[PLAT-17] sst.config.ts refuses a domain that is not a hostname in app(), before any resource or state exists', async () => {
    vi.stubEnv('PLINTHOS_AWS_REGION', 'eu-central-1');
    vi.stubEnv('PLINTHOS_DOMAIN', 'https://plinthos.example.com/');
    const config = (await import('../../sst.config')).default as { app(input: { stage: string }): Promise<unknown> };
    await expect(config.app({ stage: 'production' })).rejects.toThrow(/PLINTHOS_DOMAIN/);
    expect(fake.events).toEqual([]);
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

  it('step 4 checks which secrets are set without printing a value, and warns that the bare listing prints them (#111)', () => {
    const section = markdownSection(guide, '4. SST secrets').join('\n');
    // `sst secret list` prints `NAME=value` lines and `#` headers: the check keeps only each name.
    expect(section).toMatch(/^npx sst secret list --stage production \| grep -v '\^#' \| cut -d= -f1$/m);
    for (const name of secretNames) expect(section, name).toContain(`\`${name}\``);
    // The bare command is named only in the warning, never as a line to run.
    expect(section).not.toMatch(/^npx sst secret list --stage production$/m);
    expect(section).toMatch(/bare `npx sst secret list --stage production` prints every value in clear text/);
    for (const where of ['shared terminal', 'recorded session', 'CI log']) expect(section, where).toContain(where);
    // An exposed value: set it again, and for the password, a new password rather than a new hash of it.
    expect(section).toMatch(/If a value is exposed/);
    expect(section).toMatch(/choose a new password/);
    expect(section).toMatch(/new hash of the same password/);
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

  it('step 1 covers an IAM Identity Center (SSO) profile: log in, check the identity, log in again when it expires (#110)', () => {
    const step = markdownSection(guide, '1. What you need').join('\n');
    expect(step).toContain('aws sso login --profile');
    expect(step).toContain('aws sts get-caller-identity --query Arn --output text');
    // The ARN it prints holds the account ID, which the repository and its issues never show.
    expect(step).toMatch(/account ID/);
    expect(step).toMatch(/screenshot/);
    // A session that ends mid-deploy: log in again and re-run, unlocking a deploy it cut off.
    expect(step).toMatch(/expire/);
    expect(step).toContain('npx sst unlock --stage production');
    // Approving `aws sso login` in a browser still signed in to the access portal reuses that portal session,
    // with whatever time it has left; only signing out of the portal first starts a whole one (#115).
    expect(step).not.toMatch(/gives it the whole session/);
    expect(step).toMatch(/sign out of the AWS access portal/);
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
