import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LINKED_SECRETS, VIEWER_ADDRESS_HEADER, VIEWER_ADDRESS_INJECTION } from '../../infra/admin';
import { LOGIN_ATTEMPTS_TTL } from '../../infra/auth';
import { DeploymentConfigError, readDeploymentConfig } from '../../infra/config';
import { VIEWER_ADDRESS_HEADER as SERVER_VIEWER_ADDRESS_HEADER } from '../../src/server/auth/rate-limit';
import { ABSOLUTE_DAYS_ENV, IDLE_DAYS_ENV } from '../../src/server/auth/config';
import { readRepoFile } from '../support/repo-file';
import { installFakeSst, type FakeSst, type RecordedResource } from './fake-sst';
import { deploymentEnv, runStack } from './harness';

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

function only(type: string): RecordedResource {
  const found = fake.ofType(type);
  expect(found, type).toHaveLength(1);
  return found[0] as RecordedResource;
}

describe('the login rate limiter’s table', () => {
  it('[AUTH-12] is a DynamoDB table billed on demand, keyed by one string, whose items expire through a TTL', () => {
    runStack(fake);
    const table = only('sst:aws:Dynamo');
    expect(table.args).toMatchObject({ fields: { pk: 'string' }, primaryIndex: { hashKey: 'pk' }, ttl: LOGIN_ATTEMPTS_TTL });
    // sst.aws.Dynamo is always PAY_PER_REQUEST; nothing here asks for provisioned capacity or a stream.
    expect(table.args).not.toHaveProperty('stream');
    expect(readRepoFile('src/server/auth/rate-limit.ts')).toContain(`SET ${LOGIN_ATTEMPTS_TTL} = if_not_exists(${LOGIN_ATTEMPTS_TTL}`);
  });

  it('turns point-in-time recovery off: the counters are worth nothing after their window', () => {
    runStack(fake);
    const transform = (only('sst:aws:Dynamo').args.transform as { table: (args: Record<string, unknown>) => void }).table;
    const args: Record<string, unknown> = { pointInTimeRecovery: { enabled: true } };
    transform(args);
    expect(args.pointInTimeRecovery).toEqual({ enabled: false });
  });
});

describe('the admin’s server function', () => {
  it('[AUTH-2] [AUTH-12] is linked to the sign-in’s secrets, the database and the rate limiter’s table, and not to AlertEmail', () => {
    runStack(fake);
    const admin = only('sst:aws:Nextjs');
    const linked = admin.args.link as object[];
    const secrets = fake.ofType('sst:sst:Secret');
    const byName = (name: string) => secrets.find((secret) => secret.name === name)?.instance;
    expect(linked).toEqual(
      expect.arrayContaining([
        ...LINKED_SECRETS.map(byName),
        only('sst:aws:Aurora').instance,
        only('sst:aws:Dynamo').instance,
        // The snapshot, which the publish step writes (#19, tests/infra/snapshot.test.ts).
        only('sst:sst:Linkable').instance,
      ]),
    );
    expect(linked).toHaveLength(LINKED_SECRETS.length + 3);
    expect(linked).not.toContain(byName('AlertEmail'));
    expect([...LINKED_SECRETS].sort()).toEqual(['AdminPasswordHash', 'AdminUsername', 'SessionSecret']);
  });

  it('[AUTH-11] receives both session lifetimes from the deployment’s configuration, 7 and 30 days by default', () => {
    runStack(fake);
    expect(only('sst:aws:Nextjs').args.environment).toEqual({ [IDLE_DAYS_ENV]: '7', [ABSOLUTE_DAYS_ENV]: '30' });
    fake.uninstall();
    fake = installFakeSst();
    runStack(fake, deploymentEnv({ PLINTHOS_SESSION_IDLE_DAYS: '2', PLINTHOS_SESSION_ABSOLUTE_DAYS: '14' }));
    expect(only('sst:aws:Nextjs').args.environment).toEqual({ [IDLE_DAYS_ENV]: '2', [ABSOLUTE_DAYS_ENV]: '14' });
  });

  it('[AUTH-11] [PLAT-2] refuses a lifetime that is not a whole number of days, or an idle lifetime longer than the absolute one', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    expect(readDeploymentConfig(region)).toMatchObject({ sessionIdleDays: 7, sessionAbsoluteDays: 30 });
    for (const bad of ['0', '1.5', 'seven', '366', '-1']) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_SESSION_IDLE_DAYS: bad }), bad).toThrow(/PLINTHOS_SESSION_IDLE_DAYS/);
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_SESSION_ABSOLUTE_DAYS: bad }), bad).toThrow(/PLINTHOS_SESSION_ABSOLUTE_DAYS/);
    }
    expect(() => readDeploymentConfig({ ...region, PLINTHOS_SESSION_IDLE_DAYS: '31' })).toThrow(DeploymentConfigError);
  });

  it('[AUTH-12] has CloudFront set the viewer’s address in the header the limiter reads, overwriting what the viewer sent', () => {
    runStack(fake);
    const edge = only('sst:aws:Nextjs').args.edge as { viewerRequest: { injection: string } };
    expect(edge.viewerRequest.injection).toBe(VIEWER_ADDRESS_INJECTION);
    expect(VIEWER_ADDRESS_HEADER).toBe(SERVER_VIEWER_ADDRESS_HEADER);
    // An assignment, not an append: a value the viewer sent is replaced.
    expect(VIEWER_ADDRESS_INJECTION).toBe(`event.request.headers["${VIEWER_ADDRESS_HEADER}"] = { value: event.viewer.ip };`);
  });
});
