import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPEN_NEXT_OUTPUT, PREBUILT_CHECK } from '../../infra/admin';
import { GuardRefusal, LOG_RETENTION_DAYS, registerGuards } from '../../infra/guards';
import { installFakeSst, type FakeSst, type RecordedTransform } from './fake-sst';
import { runStack, stackSources } from './harness';

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

/** Runs every guard registered on `type` against a resource's arguments, as a deploy would. */
function construct(type: string, args: Record<string, unknown> | undefined, name = 'Probe'): void {
  const guards: RecordedTransform[] = fake.transforms.filter((transform) => transform.type === type);
  expect(guards.length, `no guard is registered on ${type}`).toBeGreaterThan(0);
  for (const guard of guards) guard.callback(args, {}, name);
}

// What the stack may create at rest: the alert topic, its policy and e-mail subscription, the
// budget, the SST secrets and the admin's shell (brief #6, Issue C). A new type here is a cost
// question first (AGENTS.md §3).
const ALLOWED = [
  'aws:budgets/budget:Budget',
  'aws:sns/topic:Topic',
  'aws:sns/topicPolicy:TopicPolicy',
  'aws:sns/topicSubscription:TopicSubscription',
  'sst:aws:Nextjs',
  'sst:sst:Secret',
];

describe('the cost guards', () => {
  it('[PLAT-5] refuse a NAT gateway, an Elastic IP and a public IPv4 address on an instance', () => {
    registerGuards();
    expect(() => construct('aws:ec2/natGateway:NatGateway', { subnetId: 'subnet' })).toThrow(GuardRefusal);
    expect(() => construct('aws:ec2/natGateway:NatGateway', { subnetId: 'subnet' })).toThrow(/\[PLAT-5\] refuses a NAT gateway/);
    expect(() => construct('aws:ec2/eip:Eip', {})).toThrow(/\[PLAT-5\] refuses an Elastic IP/);
    expect(() => construct('aws:ec2/instance:Instance', { associatePublicIpAddress: true })).toThrow(/public IPv4/);
    expect(() => construct('aws:ec2/instance:Instance', { associatePublicIpAddress: false })).not.toThrow();
    expect(() => construct('aws:ec2/instance:Instance', {})).not.toThrow();
  });

  it('[PLAT-5] refuse a VPC interface endpoint, and let a free gateway endpoint through', () => {
    registerGuards();
    expect(() => construct('aws:ec2/vpcEndpoint:VpcEndpoint', { vpcEndpointType: 'Interface' })).toThrow(/interface endpoint/);
    expect(() => construct('aws:ec2/vpcEndpoint:VpcEndpoint', { vpcEndpointType: 'GatewayLoadBalancer' })).toThrow(GuardRefusal);
    expect(() => construct('aws:ec2/vpcEndpoint:VpcEndpoint', { vpcEndpointType: 'Gateway' })).not.toThrow();
    expect(() => construct('aws:ec2/vpcEndpoint:VpcEndpoint', {})).not.toThrow();
  });

  it('[PLAT-5] refuse every kind of customer-managed KMS key', () => {
    registerGuards();
    for (const type of ['aws:kms/key:Key', 'aws:kms/replicaKey:ReplicaKey', 'aws:kms/externalKey:ExternalKey']) {
      expect(() => construct(type, {}), type).toThrow(/\[PLAT-5\] refuses a customer-managed KMS key/);
    }
  });

  it('[PLAT-5] refuse a Lambda function attached to a VPC, SST’s own functions included', () => {
    registerGuards();
    const vpcConfig = { subnetIds: ['subnet'], securityGroupIds: ['sg'] };
    expect(() => construct('aws:lambda/function:Function', { vpcConfig })).toThrow(/attached to a VPC/);
    expect(() => construct('aws:lambda/function:Function', { runtime: 'nodejs24.x' })).not.toThrow();
  });

  it('[PLAT-7] refuse every recurring schedule: an EventBridge schedule rule and a Scheduler schedule', () => {
    registerGuards();
    expect(() => construct('aws:cloudwatch/eventRule:EventRule', { scheduleExpression: 'rate(5 minutes)' })).toThrow(
      /\[PLAT-7\] refuses a recurring schedule/,
    );
    expect(() => construct('aws:cloudwatch/eventRule:EventRule', { eventPattern: '{}' })).not.toThrow();
    expect(() => construct('aws:scheduler/schedule:Schedule', { scheduleExpression: 'rate(1 hour)' })).toThrow(/\[PLAT-7\]/);
  });

  it('keep every log group for 30 days', () => {
    registerGuards();
    const args: Record<string, unknown> = { retentionInDays: 3653 };
    construct('aws:cloudwatch/logGroup:LogGroup', args);
    expect(args.retentionInDays).toBe(LOG_RETENTION_DAYS);
    expect(LOG_RETENTION_DAYS).toBe(30);
  });

  it('[PLAT-5] [PLAT-7] are registered before the stack creates anything', () => {
    runStack(fake);
    const firstResource = fake.events.findIndex((event) => event.kind === 'resource');
    const lastTransform = fake.events.findLastIndex((event) => event.kind === 'transform');
    expect(firstResource).toBeGreaterThan(lastTransform);
  });
});

describe('the stack at rest', () => {
  it('[PLAT-5] creates only the resources that cost nothing at rest', () => {
    runStack(fake);
    expect([...new Set(fake.resources.map(({ type }) => type))].sort()).toEqual(ALLOWED);
  });

  it('[PLAT-5] [PLAT-7] runs the admin outside any VPC, keeps no instance warm and uses no custom domain', () => {
    runStack(fake);
    const [admin] = fake.ofType('sst:aws:Nextjs');
    expect(admin?.args).not.toHaveProperty('vpc');
    expect(admin?.args).not.toHaveProperty('warm');
    expect(admin?.args).not.toHaveProperty('domain');
    expect(admin?.args.server).toEqual({ runtime: 'nodejs24.x' });
  });

  it('[PLAT-5] encrypts the alert topic with no customer-managed key', () => {
    runStack(fake);
    const [topic] = fake.ofType('aws:sns/topic:Topic');
    expect(topic?.args).not.toHaveProperty('kmsMasterKeyId');
  });

  it('[PLAT-5] [PLAT-7] no module constructs a NAT, an address, an endpoint, a key, a VPC or a schedule', () => {
    const forbidden = /\b(?:NatGateway|Eip|VpcEndpoint|kms\.Key|Vpc|Cron|CronV2|EventRule|scheduler\.Schedule)\s*\(/;
    for (const { path, source } of stackSources()) {
      for (const line of source.split('\n').filter((l) => /\bnew\s/.test(l))) expect(line, path).not.toMatch(forbidden);
    }
  });
});

describe('the admin deploys a prebuilt OpenNext output', () => {
  it('[PLAT-4] its build command only checks that the build hook’s output is in place', () => {
    runStack(fake);
    const [admin] = fake.ofType('sst:aws:Nextjs');
    expect(admin?.args.buildCommand).toBe(PREBUILT_CHECK);
    // A test of one file, and a message naming the step that was missed: nothing it could build with.
    expect(PREBUILT_CHECK.startsWith(`test -f ${OPEN_NEXT_OUTPUT} || { echo "`)).toBe(true);
    expect(PREBUILT_CHECK).toMatch(/^test -f \S+ \|\| \{ echo "[^"$`]*" >&2; exit 1; \}$/);
  });
});
