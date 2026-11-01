/**
 * What a deployment configures: its one stage, its configuration values and its SST secrets.
 *
 * Everything owner-specific comes from here and nowhere else ([PLAT-2]): the region, the budget
 * limit and Aurora's maximum capacity from the environment `sst` runs in, and the admin's
 * account, the session secret and the alert e-mail address from SST secrets. `docs/deploy.md` names every one with how to set
 * it, and `tests/infra/configuration.test.ts` fails when the stack reads one the guide does not
 * name ([PLAT-3]). This module is plain TypeScript with no SST global, so `sst.config.ts`'s
 * `app()` and the tests can both call it.
 */

/** The one stage this app deploys ([PLAT-1]). There is no dev or staging stage. */
export const STAGE = 'production';

/**
 * The Pulumi AWS provider `sst.config.ts` and `sst.types.config.ts` both pin, so the types the
 * typecheck installs are the provider the deploy runs.
 */
export const AWS_PROVIDER_VERSION = '7.20.0';

/** The monthly budget limit when the deployment sets none ([PLAT-6]). */
export const DEFAULT_BUDGET_LIMIT_USD = '10';

/**
 * Aurora's maximum capacity when the deployment sets none ([PLAT-8]): 1 ACU, which caps an
 * awake hour at about $0.14 in Frankfurt (brief #6, decision 4).
 */
export const DEFAULT_AURORA_MAX_ACU = '1';

export interface ConfigurationValue {
  /** The environment variable `sst` reads it from. */
  readonly name: string;
  readonly required: boolean;
  /** The value used when an optional one is unset. */
  readonly fallback?: string;
  readonly description: string;
}

/** Every configuration value the stack reads, from the environment `sst` runs in. */
export const CONFIGURATION: readonly ConfigurationValue[] = [
  {
    name: 'PLINTHOS_AWS_REGION',
    required: true,
    description: 'The AWS region the whole deployment lives in, such as eu-central-1.',
  },
  {
    name: 'PLINTHOS_BUDGET_LIMIT_USD',
    required: false,
    fallback: DEFAULT_BUDGET_LIMIT_USD,
    description: "The monthly AWS Budgets limit in US dollars, which the alerts are measured against.",
  },
  {
    name: 'PLINTHOS_AURORA_MAX_ACU',
    required: false,
    fallback: DEFAULT_AURORA_MAX_ACU,
    description: "Aurora's maximum capacity in ACUs, from 1 to 256 in steps of 0.5. Its minimum is always 0, so it pauses.",
  },
];

export interface SecretDefinition {
  /** The SST secret's name, as `sst secret set` takes it. */
  readonly name: string;
  readonly description: string;
}

/** Every SST secret the stack reads. A deploy with any of them unset fails and names it. */
export const SECRETS: readonly SecretDefinition[] = [
  { name: 'AdminUsername', description: "The admin's sign-in name." },
  { name: 'AdminPasswordHash', description: "The scrypt hash of the admin's password, never the password itself." },
  { name: 'SessionSecret', description: 'The key that signs session cookies: at least 32 random bytes.' },
  { name: 'AlertEmail', description: 'The address the alert topic e-mails: budget alerts, and every alarm after them.' },
];

export interface DeploymentConfig {
  readonly region: string;
  readonly budgetLimitUsd: number;
  readonly auroraMaxAcu: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Fails a deploy, naming what is wrong and how to fix it, before any resource is created. */
export class DeploymentConfigError extends Error {
  override name = 'DeploymentConfigError';
}

/** Refuses every stage but `production` ([PLAT-1]). */
export function resolveStage(stage: string): typeof STAGE {
  if (stage !== STAGE) {
    throw new DeploymentConfigError(
      `Plinthos deploys only the stage "${STAGE}", not "${stage}": run sst with --stage ${STAGE} (docs/deploy.md).`,
    );
  }
  return STAGE;
}

// An AWS region code, such as eu-central-1 or us-gov-west-1.
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** Reads the configuration values, failing on the first required one unset and naming it. */
export function readDeploymentConfig(env: Env): DeploymentConfig {
  const missing = CONFIGURATION.filter(({ name, required }) => required && blank(env[name])).map(({ name }) => name);
  if (missing.length > 0) {
    throw new DeploymentConfigError(
      `Set ${missing.join(', ')} in the environment sst runs in: ${missing.length === 1 ? 'it is' : 'they are'} required (docs/deploy.md).`,
    );
  }
  const region = (env.PLINTHOS_AWS_REGION ?? '').trim();
  if (!REGION.test(region)) {
    throw new DeploymentConfigError(`PLINTHOS_AWS_REGION is "${region}", which is not an AWS region code such as eu-central-1.`);
  }
  const budget = blank(env.PLINTHOS_BUDGET_LIMIT_USD) ? DEFAULT_BUDGET_LIMIT_USD : (env.PLINTHOS_BUDGET_LIMIT_USD ?? '').trim();
  const budgetLimitUsd = Number(budget);
  if (!/^\d+(\.\d{1,2})?$/.test(budget) || !(budgetLimitUsd > 0)) {
    throw new DeploymentConfigError(`PLINTHOS_BUDGET_LIMIT_USD is "${budget}", which is not a positive amount of US dollars such as 10.`);
  }
  const maxAcu = blank(env.PLINTHOS_AURORA_MAX_ACU) ? DEFAULT_AURORA_MAX_ACU : (env.PLINTHOS_AURORA_MAX_ACU ?? '').trim();
  const auroraMaxAcu = Number(maxAcu);
  // Aurora Serverless v2 takes a maximum from 1 to 256 ACUs, in steps of half an ACU.
  if (!/^\d+(\.[05])?$/.test(maxAcu) || auroraMaxAcu < 1 || auroraMaxAcu > 256) {
    throw new DeploymentConfigError(`PLINTHOS_AURORA_MAX_ACU is "${maxAcu}", which is not a capacity from 1 to 256 ACUs in steps of 0.5, such as 1.`);
  }
  return { region, budgetLimitUsd, auroraMaxAcu };
}

/**
 * Fails when any SST secret is unset, naming every missing one with the command that sets it.
 * `sst` puts each secret it holds for the stage into the program's environment as
 * `SST_SECRET_<name>`, so this runs before any resource is created.
 */
export function assertSecretsSet(env: Env): void {
  const missing = SECRETS.filter(({ name }) => blank(env[`SST_SECRET_${name}`])).map(({ name }) => name);
  if (missing.length > 0) {
    throw new DeploymentConfigError(
      [
        `Set the SST secret${missing.length === 1 ? '' : 's'} ${missing.join(', ')} before deploying (docs/deploy.md):`,
        ...missing.map((name) => `  npx sst secret set ${name} <value> --stage ${STAGE}`),
      ].join('\n'),
    );
  }
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}
