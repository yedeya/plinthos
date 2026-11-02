/**
 * What a deployment configures: its one stage, its configuration values and its SST secrets.
 *
 * Everything owner-specific comes from here and nowhere else ([PLAT-2]): the region, the budget
 * limit, Aurora's maximum capacity, the session lifetimes, the login limits, the photo settings and the parts file's size cap from the environment `sst` runs in, and the admin's
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

/** The session lifetimes when the deployment sets none ([AUTH-11], brief #6, decision 3). */
export const DEFAULT_SESSION_IDLE_DAYS = '7';
export const DEFAULT_SESSION_ABSOLUTE_DAYS = '30';

/** The login limits when the deployment sets none ([AUTH-13], #62): per address, and in total, per 15 minutes. */
export const DEFAULT_LOGIN_ATTEMPTS_PER_ADDRESS = '10';
export const DEFAULT_LOGIN_ATTEMPTS_TOTAL = '100';

/**
 * The photo path's settings when the deployment sets none ([PHOTO-1]): the longest edge the phone
 * resizes to, and the size cap of an upload, in bytes. `src/server/photos/config.ts` holds the
 * same defaults and bounds, and `tests/infra/photos.test.ts` holds the two together.
 */
export const DEFAULT_PHOTO_LONGEST_EDGE = '2048';
export const DEFAULT_PHOTO_MAX_BYTES = '4194304';
export const PHOTO_LONGEST_EDGE_RANGE = { min: 320, max: 8192 } as const;
export const PHOTO_MAX_BYTES_RANGE = { min: 65536, max: 20971520 } as const;

/**
 * The largest parts file upload, in bytes, when the deployment sets none ([PARTS-2], #161): 20 MiB,
 * well above a 50,000-part BrickStore file (brief #153, §8). `src/server/parts/config.ts` holds the
 * same default and bounds, and `tests/infra/configuration.test.ts` holds the two together.
 */
export const DEFAULT_PARTS_MAX_BYTES = '20971520';
export const PARTS_MAX_BYTES_RANGE = { min: 65536, max: 52428800 } as const;

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
  {
    name: 'PLINTHOS_SESSION_IDLE_DAYS',
    required: false,
    fallback: DEFAULT_SESSION_IDLE_DAYS,
    description: 'Days a session lasts without a visit before it ends, from 1 to 365.',
  },
  {
    name: 'PLINTHOS_SESSION_ABSOLUTE_DAYS',
    required: false,
    fallback: DEFAULT_SESSION_ABSOLUTE_DAYS,
    description: 'Days a session lasts at most, however often it is used, from 1 to 365 and no shorter than the idle lifetime.',
  },
  {
    name: 'PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS',
    required: false,
    fallback: DEFAULT_LOGIN_ATTEMPTS_PER_ADDRESS,
    description: 'Sign-in attempts one address may make in 15 minutes before it is refused: a whole number, at least 1 and lower than the total.',
  },
  {
    name: 'PLINTHOS_LOGIN_ATTEMPTS_TOTAL',
    required: false,
    fallback: DEFAULT_LOGIN_ATTEMPTS_TOTAL,
    description: 'Sign-in attempts every address together may make in 15 minutes before all are refused: a whole number, at least 1.',
  },
  {
    name: 'PLINTHOS_PHOTO_LONGEST_EDGE',
    required: false,
    fallback: DEFAULT_PHOTO_LONGEST_EDGE,
    description: 'The longest edge, in pixels, the phone resizes a photo to before it uploads it: a whole number from 320 to 8192.',
  },
  {
    name: 'PLINTHOS_PHOTO_MAX_BYTES',
    required: false,
    fallback: DEFAULT_PHOTO_MAX_BYTES,
    description: 'The largest photo upload, in bytes, that S3 and the server accept: a whole number from 65536 to 20971520.',
  },
  {
    name: 'PLINTHOS_PARTS_MAX_BYTES',
    required: false,
    fallback: DEFAULT_PARTS_MAX_BYTES,
    description: 'The largest parts file upload, in bytes, that S3 and the server accept: a whole number from 65536 to 52428800.',
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
  { name: 'RebrickableApiKey', description: "The Rebrickable API key the set lookup sends, from a free Rebrickable account's settings." },
];

export interface DeploymentConfig {
  readonly region: string;
  readonly budgetLimitUsd: number;
  readonly auroraMaxAcu: number;
  readonly sessionIdleDays: number;
  readonly sessionAbsoluteDays: number;
  readonly loginAttemptsPerAddress: number;
  readonly loginAttemptsTotal: number;
  readonly photoLongestEdge: number;
  readonly photoMaxBytes: number;
  readonly partsMaxBytes: number;
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
  const sessionIdleDays = readDays(env, 'PLINTHOS_SESSION_IDLE_DAYS', DEFAULT_SESSION_IDLE_DAYS);
  const sessionAbsoluteDays = readDays(env, 'PLINTHOS_SESSION_ABSOLUTE_DAYS', DEFAULT_SESSION_ABSOLUTE_DAYS);
  if (sessionIdleDays > sessionAbsoluteDays) {
    throw new DeploymentConfigError(
      `PLINTHOS_SESSION_IDLE_DAYS is ${sessionIdleDays}, longer than PLINTHOS_SESSION_ABSOLUTE_DAYS, ${sessionAbsoluteDays}: a session can't stay idle longer than it lasts.`,
    );
  }
  const loginAttemptsPerAddress = readAttempts(env, 'PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS', DEFAULT_LOGIN_ATTEMPTS_PER_ADDRESS);
  const loginAttemptsTotal = readAttempts(env, 'PLINTHOS_LOGIN_ATTEMPTS_TOTAL', DEFAULT_LOGIN_ATTEMPTS_TOTAL);
  if (loginAttemptsPerAddress >= loginAttemptsTotal) {
    throw new DeploymentConfigError(
      `PLINTHOS_LOGIN_ATTEMPTS_PER_ADDRESS is ${loginAttemptsPerAddress}, not lower than PLINTHOS_LOGIN_ATTEMPTS_TOTAL, ${loginAttemptsTotal}: one address could use up the total and lock every other address out of the sign-in.`,
    );
  }
  const photoLongestEdge = readWhole(env, 'PLINTHOS_PHOTO_LONGEST_EDGE', DEFAULT_PHOTO_LONGEST_EDGE, PHOTO_LONGEST_EDGE_RANGE, 'pixels');
  const photoMaxBytes = readWhole(env, 'PLINTHOS_PHOTO_MAX_BYTES', DEFAULT_PHOTO_MAX_BYTES, PHOTO_MAX_BYTES_RANGE, 'bytes');
  const partsMaxBytes = readWhole(env, 'PLINTHOS_PARTS_MAX_BYTES', DEFAULT_PARTS_MAX_BYTES, PARTS_MAX_BYTES_RANGE, 'bytes');
  return {
    region,
    budgetLimitUsd,
    auroraMaxAcu,
    sessionIdleDays,
    sessionAbsoluteDays,
    loginAttemptsPerAddress,
    loginAttemptsTotal,
    photoLongestEdge,
    photoMaxBytes,
    partsMaxBytes,
  };
}

/** A whole number within a range, or the fallback when unset. */
function readWhole(env: Env, name: string, fallback: string, range: { readonly min: number; readonly max: number }, unit: string): number {
  const value = blank(env[name]) ? fallback : (env[name] ?? '').trim();
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < range.min || parsed > range.max) {
    throw new DeploymentConfigError(`${name} is "${value}", which is not a whole number of ${unit} from ${range.min} to ${range.max}, such as ${fallback}.`);
  }
  return parsed;
}

/** A whole number of days from 1 to 365, or the fallback when unset. */
function readDays(env: Env, name: string, fallback: string): number {
  const value = blank(env[name]) ? fallback : (env[name] ?? '').trim();
  const days = Number(value);
  if (!/^\d+$/.test(value) || days < 1 || days > 365) {
    throw new DeploymentConfigError(`${name} is "${value}", which is not a whole number of days from 1 to 365, such as ${fallback}.`);
  }
  return days;
}

/** A whole number of attempts, at least 1, or the fallback when unset. */
function readAttempts(env: Env, name: string, fallback: string): number {
  const value = blank(env[name]) ? fallback : (env[name] ?? '').trim();
  const attempts = Number(value);
  if (!/^\d+$/.test(value) || attempts < 1 || !Number.isSafeInteger(attempts)) {
    throw new DeploymentConfigError(`${name} is "${value}", which is not a whole number of attempts of at least 1, such as ${fallback}.`);
  }
  return attempts;
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
