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

// What the stack may create, each priced in brief #6's §4: the alert topic, its policy and e-mail
// subscription, the budget, the SST secrets and the admin's shell (Issue C), the database, its
// VPC's free parts and its not-paused alarm (Issue D), and the login rate limiter's on-demand
// DynamoDB table (Issue F, decision 14). A new type here is a cost question first (AGENTS.md §3).
const ALLOWED = [
  'aws:budgets/budget:Budget',
  'aws:cloudwatch/metricAlarm:MetricAlarm',
  'aws:ec2/defaultSecurityGroup:DefaultSecurityGroup',
  'aws:ec2/subnet:Subnet',
  'aws:ec2/vpc:Vpc',
  'aws:sns/topic:Topic',
  'aws:sns/topicPolicy:TopicPolicy',
  'aws:sns/topicSubscription:TopicSubscription',
  'sst:aws:Aurora',
  'sst:aws:Dynamo',
  'sst:aws:Nextjs',
  'sst:sst:Secret',
];

/**
 * Stands in for an input only a deploy resolves, such as the output `sst.aws.Service` passes as
 * `assignPublicIp`: a promise, which Pulumi takes wherever it takes an output.
 */
const UNRESOLVED = new Promise<never>(() => undefined);

/** Every resource type the AWS provider lets reach a public network through `publiclyAccessible`. */
const PUBLICLY_ACCESSIBLE = [
  'aws:dms/replicationInstance:ReplicationInstance',
  'aws:docdb/clusterInstance:ClusterInstance',
  'aws:lightsail/database:Database',
  'aws:m2/environment:Environment',
  'aws:mq/broker:Broker',
  'aws:neptune/clusterInstance:ClusterInstance',
  'aws:rds/clusterInstance:ClusterInstance',
  'aws:rds/instance:Instance',
  'aws:rds/shardGroup:ShardGroup',
  'aws:redshift/cluster:Cluster',
  'aws:redshiftserverless/workgroup:Workgroup',
  'aws:timestreaminfluxdb/dbCluster:DbCluster',
  'aws:timestreaminfluxdb/dbInstance:DbInstance',
];

describe('the cost guards', () => {
  it('[PLAT-5] refuse a NAT gateway and an Elastic IP', () => {
    registerGuards();
    expect(() => construct('aws:ec2/natGateway:NatGateway', { subnetId: 'subnet' })).toThrow(GuardRefusal);
    expect(() => construct('aws:ec2/natGateway:NatGateway', { subnetId: 'subnet' })).toThrow(/\[PLAT-5\] refuses a NAT gateway/);
    expect(() => construct('aws:ec2/eip:Eip', {})).toThrow(/\[PLAT-5\] refuses an Elastic IP/);
  });

  it('[PLAT-5] refuse an instance unless it turns its public IPv4 address off, because its subnet’s default may give it one', () => {
    registerGuards();
    for (const type of [
      'aws:ec2/instance:Instance',
      'aws:ec2/spotInstanceRequest:SpotInstanceRequest',
      'aws:ec2/launchConfiguration:LaunchConfiguration',
    ]) {
      expect(() => construct(type, {}), type).toThrow(/\[PLAT-5\] refuses an instance without associatePublicIpAddress: false/);
      expect(() => construct(type, undefined), type).toThrow(GuardRefusal);
      expect(() => construct(type, { associatePublicIpAddress: true }), type).toThrow(GuardRefusal);
      expect(() => construct(type, { associatePublicIpAddress: UNRESOLVED }), type).toThrow(GuardRefusal);
      expect(() => construct(type, { associatePublicIpAddress: false }), type).not.toThrow();
    }
  });

  it('[PLAT-5] refuse a launch template unless every network interface it declares turns its public IPv4 address off', () => {
    registerGuards();
    const template = 'aws:ec2/launchTemplate:LaunchTemplate';
    const refusal = /\[PLAT-5\] refuses a launch template without associatePublicIpAddress: false/;
    expect(() => construct(template, {})).toThrow(refusal);
    expect(() => construct(template, { networkInterfaces: [] })).toThrow(refusal);
    expect(() => construct(template, { networkInterfaces: UNRESOLVED })).toThrow(refusal);
    expect(() => construct(template, { networkInterfaces: [{ associatePublicIpAddress: 'true' }] })).toThrow(refusal);
    expect(() => construct(template, { networkInterfaces: [{ associatePublicIpAddress: 'false' }, {}] })).toThrow(refusal);
    expect(() => construct(template, { networkInterfaces: [{ associatePublicIpAddress: 'false' }] })).not.toThrow();
    expect(() => construct(template, { networkInterfaces: [{ associatePublicIpAddress: false }] })).not.toThrow();
  });

  it('[PLAT-5] refuse a spot fleet that specifies its own instances, which take their subnet’s default', () => {
    registerGuards();
    const fleet = 'aws:ec2/spotFleetRequest:SpotFleetRequest';
    expect(() => construct(fleet, { launchSpecifications: [{ associatePublicIpAddress: false }] })).toThrow(/\[PLAT-5\] refuses a spot fleet/);
    expect(() => construct(fleet, { launchSpecifications: UNRESOLVED })).toThrow(GuardRefusal);
    // A fleet built from launch templates is held by the launch template's guard.
    expect(() => construct(fleet, { launchTemplateConfigs: [{}] })).not.toThrow();
  });

  it('[PLAT-5] refuse a subnet that gives every instance a public IPv4 address, and a default subnet unless it stops', () => {
    registerGuards();
    const subnet = 'aws:ec2/subnet:Subnet';
    expect(() => construct(subnet, { mapPublicIpOnLaunch: true })).toThrow(/\[PLAT-5\] refuses a subnet that maps a public IPv4 address/);
    expect(() => construct(subnet, { mapPublicIpOnLaunch: UNRESOLVED })).toThrow(GuardRefusal);
    expect(() => construct(subnet, { mapPublicIpOnLaunch: false })).not.toThrow();
    expect(() => construct(subnet, {})).not.toThrow();
    // Every default subnet maps one unless it is told not to.
    const defaultSubnet = 'aws:ec2/defaultSubnet:DefaultSubnet';
    expect(() => construct(defaultSubnet, {})).toThrow(/\[PLAT-5\] refuses a subnet that maps a public IPv4 address/);
    expect(() => construct(defaultSubnet, { mapPublicIpOnLaunch: true })).toThrow(GuardRefusal);
    expect(() => construct(defaultSubnet, { mapPublicIpOnLaunch: false })).not.toThrow();
  });

  it('[PLAT-5] refuse an ECS service, task set, event target or pipe that gives its tasks a public IPv4 address', () => {
    registerGuards();
    const refusal = /\[PLAT-5\] refuses a task with a public IPv4 address/;
    const cases: [string, (assignPublicIp: unknown) => Record<string, unknown>][] = [
      ['aws:ecs/service:Service', (assignPublicIp) => ({ networkConfiguration: { subnets: ['subnet'], assignPublicIp } })],
      ['aws:ecs/taskSet:TaskSet', (assignPublicIp) => ({ networkConfiguration: { subnets: ['subnet'], assignPublicIp } })],
      ['aws:cloudwatch/eventTarget:EventTarget', (assignPublicIp) => ({ ecsTarget: { networkConfiguration: { subnets: ['subnet'], assignPublicIp } } })],
      [
        'aws:pipes/pipe:Pipe',
        (assignPublicIp) => ({ targetParameters: { ecsTaskParameters: { networkConfiguration: { awsVpcConfiguration: { assignPublicIp } } } } }),
      ],
    ];
    for (const [type, args] of cases) {
      expect(() => construct(type, args(true)), type).toThrow(refusal);
      expect(() => construct(type, args('ENABLED')), type).toThrow(refusal);
      expect(() => construct(type, args(UNRESOLVED)), type).toThrow(refusal);
      expect(() => construct(type, args(false)), type).not.toThrow();
      expect(() => construct(type, args('DISABLED')), type).not.toThrow();
      // AWS assigns a task no public address unless it is asked to.
      expect(() => construct(type, args(undefined)), type).not.toThrow();
      expect(() => construct(type, {}), type).not.toThrow();
    }
    // A configuration only a deploy can resolve might ask for one.
    expect(() => construct('aws:ecs/service:Service', { networkConfiguration: UNRESOLVED })).toThrow(refusal);
  });

  it('[PLAT-5] refuse an internet-facing load balancer of every kind, the default when internal is unset', () => {
    registerGuards();
    for (const type of ['aws:lb/loadBalancer:LoadBalancer', 'aws:alb/loadBalancer:LoadBalancer', 'aws:elb/loadBalancer:LoadBalancer']) {
      expect(() => construct(type, {}), type).toThrow(/\[PLAT-5\] refuses an internet-facing load balancer/);
      expect(() => construct(type, { internal: false }), type).toThrow(GuardRefusal);
      expect(() => construct(type, { internal: UNRESOLVED }), type).toThrow(GuardRefusal);
      expect(() => construct(type, { internal: true }), type).not.toThrow();
    }
  });

  it('[PLAT-5] refuse a database or broker unless it turns public access off, an RDS instance in Aurora included', () => {
    registerGuards();
    for (const type of PUBLICLY_ACCESSIBLE) {
      expect(() => construct(type, { publiclyAccessible: true }), type).toThrow(/\[PLAT-5\] refuses a publicly accessible database/);
      expect(() => construct(type, { publiclyAccessible: UNRESOLVED }), type).toThrow(GuardRefusal);
      // AWS makes one public by default in a VPC with an internet gateway, so unset is refused too.
      expect(() => construct(type, {}), type).toThrow(GuardRefusal);
      expect(() => construct(type, { publiclyAccessible: false }), type).not.toThrow();
    }
  });

  it('[PLAT-5] refuse what always holds a public IPv4 address: a Lightsail instance, load balancer or static IP, and an accelerator', () => {
    registerGuards();
    for (const type of ['aws:lightsail/instance:Instance', 'aws:lightsail/lb:Lb']) {
      expect(() => construct(type, {}), type).toThrow(/\[PLAT-5\] refuses a Lightsail resource with a public IPv4 address/);
      expect(() => construct(type, { ipAddressType: 'dualstack' }), type).toThrow(GuardRefusal);
      expect(() => construct(type, { ipAddressType: 'ipv6' }), type).not.toThrow();
    }
    expect(() => construct('aws:lightsail/staticIp:StaticIp', {})).toThrow(/\[PLAT-5\] refuses a Lightsail static IP/);
    for (const type of ['aws:globalaccelerator/accelerator:Accelerator', 'aws:globalaccelerator/customRoutingAccelerator:CustomRoutingAccelerator']) {
      expect(() => construct(type, {}), type).toThrow(/\[PLAT-5\] refuses a Global Accelerator/);
    }
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
  it('[PLAT-5] creates only the resources brief #6 prices, none of which is a NAT, an address, an endpoint or a key', () => {
    runStack(fake);
    expect([...new Set(fake.resources.map(({ type }) => type))].sort()).toEqual(ALLOWED);
  });

  it('[PLAT-5] passes every guard with every resource it creates', () => {
    runStack(fake);
    for (const { type, name, args } of fake.resources) {
      for (const guard of fake.transforms.filter((transform) => transform.type === type)) {
        expect(() => guard.callback(args, {}, name), `${type} ${name}`).not.toThrow();
      }
    }
  });

  it('[PLAT-5] keeps the Aurora cluster’s instance, which SST creates inside its component, private only through its transform', () => {
    runStack(fake);
    const [aurora] = fake.ofType('sst:aws:Aurora');
    const transform = (aurora?.args.transform as { instance: (args: Record<string, unknown>) => void }).instance;
    // The instance's arguments as SST's Aurora builds them at the pinned version: no publiclyAccessible.
    const instance: Record<string, unknown> = { instanceClass: 'db.serverless', engine: 'aurora-postgresql' };
    expect(() => construct('aws:rds/clusterInstance:ClusterInstance', { ...instance }, 'DatabaseInstance')).toThrow(GuardRefusal);
    transform(instance);
    expect(() => construct('aws:rds/clusterInstance:ClusterInstance', instance, 'DatabaseInstance')).not.toThrow();
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

  it('[PLAT-5] [PLAT-7] no module constructs a NAT, an address, an endpoint, a key, an internet gateway, SST’s Vpc or a schedule', () => {
    // `sst.aws.Vpc` always adds a Cloud Map namespace, a billed private Route 53 zone, and public
    // subnets; infra/database.ts builds the VPC from its free parts instead.
    const forbidden = /\b(?:NatGateway|Eip|VpcEndpoint|kms\.Key|InternetGateway|sst\.aws\.Vpc|Cron|CronV2|EventRule|scheduler\.Schedule)\s*\(/;
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
