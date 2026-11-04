import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRICE_JOB_HANDLER, priceJobName } from '../../infra/prices';
import { BRICKLINK_SECRETS } from '../../src/server/valuation/bricklink';
import { PRICE_JOB_LINK } from '../../src/server/valuation/invoker';
import { repoRoot } from '../support/repo-file';
import { FAKE_ACCOUNT, installFakeSst, type FakeSst } from './fake-sst';
import { deploymentEnv, runStack } from './harness';

/**
 * The price refresh's background job (brief #226, Issue A, [VAL-9]): `infra/prices.ts`, through the
 * whole stack against the stand-ins. Every ARN is made up, with the account `000000000000`.
 */

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

function job() {
  const functions = fake.ofType('sst:aws:Function').filter((resource) => resource.name === 'PriceRefresh');
  expect(functions).toHaveLength(1);
  const [found] = functions;
  if (found === undefined) throw new Error('no function');
  return found;
}

describe('the price refresh’s job function', () => {
  it('[VAL-9] runs the worker on Node 24 and arm64, with 512 MB, a 15-minute timeout and no async retry, and no URL or reserved concurrency', () => {
    runStack(fake);
    const { name, args } = job();
    expect(name).toBe(PRICE_JOB_LINK);
    expect(args).toMatchObject({ handler: PRICE_JOB_HANDLER, runtime: 'nodejs24.x', architecture: 'arm64', memory: '512 MB', timeout: '15 minutes', retries: 0 });
    // A URL would let anyone invoke it; reserved concurrency would take from a new account's 10.
    for (const key of ['url', 'concurrency', 'vpc', 'dev', 'streaming', 'policies']) expect(args, key).not.toHaveProperty(key);
    // The handler is the worker module and its `handler` export.
    const [module, exported] = [PRICE_JOB_HANDLER.slice(0, PRICE_JOB_HANDLER.lastIndexOf('.')), PRICE_JOB_HANDLER.slice(PRICE_JOB_HANDLER.lastIndexOf('.') + 1)];
    expect(existsSync(join(repoRoot, `${module}.ts`))).toBe(true);
    expect(exported).toBe('handler');
  });

  it('[VAL-9] is linked to the database and the four BrickLink secrets alone, with the currency in its environment', () => {
    runStack(fake, deploymentEnv({ PLINTHOS_CURRENCY: 'USD' }));
    const { args } = job();
    const secrets = fake.ofType('sst:sst:Secret');
    const byName = (name: string) => secrets.find((secret) => secret.name === name)?.instance;
    const [database] = fake.ofType('sst:aws:Aurora');
    expect(args.link).toEqual([database?.instance, ...BRICKLINK_SECRETS.map(byName)]);
    expect(args.environment).toEqual({ PLINTHOS_CURRENCY: 'USD' });
  });

  it('[VAL-9] may invoke itself and nothing else, and the admin’s server may invoke it through its link', () => {
    runStack(fake);
    const { args, instance } = job();
    const name = priceJobName({ name: 'plinthos', stage: 'production' });
    expect(args.name).toBe(name);
    expect(args.permissions).toEqual([{ actions: ['lambda:InvokeFunction'], resources: [`arn:aws:lambda:eu-central-1:${FAKE_ACCOUNT}:function:${name}`] }]);
    const [admin] = fake.ofType('sst:aws:Nextjs');
    expect(admin?.args.link as object[]).toContain(instance);
    // Nothing else links the job.
    for (const resource of fake.resources.filter((candidate) => candidate.type !== 'sst:aws:Nextjs')) {
      expect((resource.args.link as object[] | undefined) ?? [], resource.name).not.toContain(instance);
    }
  });
});
