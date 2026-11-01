import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_NAME, NOT_PAUSED_ALARM, NOT_PAUSED_HOURS, SUBNET_CIDRS, VPC_CIDR } from '../../infra/database';
import { auroraPostgresMajor } from '../support/aurora';
import { FAKE_ZONES, installFakeSst, type FakeSst, type RecordedResource } from './fake-sst';
import { deploymentEnv, runStack } from './harness';

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

function only(type: string): RecordedResource {
  const found = fake.ofType(type);
  expect(found, type).toHaveLength(1);
  const [resource] = found;
  if (resource === undefined) throw new Error(`no ${type}`);
  return resource;
}

const arn = (resource: RecordedResource) => `arn:fake:${resource.type}:${resource.name}`;

describe('the Aurora cluster', () => {
  it('[PLAT-8] is Aurora Serverless v2 PostgreSQL with a 0 ACU minimum, so it pauses, and the Data API on', () => {
    runStack(fake);
    const aurora = only('sst:aws:Aurora');
    expect(aurora.name).toBe('Database');
    expect(aurora.args).toMatchObject({ engine: 'postgres', dataApi: true, database: DATABASE_NAME });
    expect(aurora.args.scaling).toEqual({ min: '0 ACU', max: '1 ACU' });
    // A pause after SST's default of five idle minutes: nothing shortens or disables it.
    expect(aurora.args.scaling).not.toHaveProperty('pauseAfter');
    // No proxy, no replica: either would keep the cluster awake or bill it twice.
    expect(aurora.args).not.toHaveProperty('proxy');
    expect(aurora.args).not.toHaveProperty('replicas');
  });

  it('[PLAT-8] pins a 16.x engine of at least 16.3, which a 0 ACU minimum needs, and the test database matches it', () => {
    runStack(fake);
    const version = String(only('sst:aws:Aurora').args.version);
    const [major, minor] = version.split('.').map(Number);
    expect(major).toBe(16);
    expect(minor).toBeGreaterThanOrEqual(3);
    expect(auroraPostgresMajor()).toBe(major);
  });

  it('[PLAT-8] takes its maximum capacity from the deployment’s configuration, 1 ACU by default', () => {
    runStack(fake, deploymentEnv({ PLINTHOS_AURORA_MAX_ACU: '2.5' }));
    expect(only('sst:aws:Aurora').args.scaling).toEqual({ min: '0 ACU', max: '2.5 ACU' });
  });

  it('[PLAT-8] is not publicly accessible: its instance says so, in private subnets, behind a security group with no rule', () => {
    runStack(fake);
    const aurora = only('sst:aws:Aurora');
    const transform = (aurora.args.transform as { instance: (args: Record<string, unknown>) => void }).instance;
    const instance: Record<string, unknown> = { publiclyAccessible: true };
    transform(instance);
    expect(instance.publiclyAccessible).toBe(false);

    const subnets = fake.ofType('aws:ec2/subnet:Subnet');
    const securityGroup = only('aws:ec2/defaultSecurityGroup:DefaultSecurityGroup');
    expect(aurora.args.vpc).toEqual({ subnets: subnets.map(({ name }) => name), securityGroups: [securityGroup.name] });
    expect(securityGroup.args).toMatchObject({ ingress: [], egress: [] });
    for (const subnet of subnets) expect(subnet.args.mapPublicIpOnLaunch, subnet.name).toBe(false);
  });

  it('[PLAT-8] has deletion protection on, so nothing deletes it until the owner switches it off', () => {
    runStack(fake);
    const aurora = only('sst:aws:Aurora');
    const transform = (aurora.args.transform as { cluster: (args: Record<string, unknown>) => void }).cluster;
    const cluster: Record<string, unknown> = { deletionProtection: false };
    transform(cluster);
    expect(cluster.deletionProtection).toBe(true);
  });
});

describe('the database VPC', () => {
  it('[PLAT-5] [PLAT-8] is a VPC with two private subnets in two zones, and nothing that routes out of it', () => {
    runStack(fake);
    const vpc = only('aws:ec2/vpc:Vpc');
    expect(vpc.args.cidrBlock).toBe(VPC_CIDR);
    const subnets = fake.ofType('aws:ec2/subnet:Subnet');
    expect(subnets.map(({ args }) => args.cidrBlock)).toEqual([...SUBNET_CIDRS]);
    expect(subnets.map(({ args }) => args.availabilityZone)).toEqual(FAKE_ZONES.slice(0, 2));
    for (const subnet of subnets) expect(subnet.args.vpcId).toBe(vpc.name);
    expect(only('aws:ec2/defaultSecurityGroup:DefaultSecurityGroup').args.vpcId).toBe(vpc.name);
    // No internet gateway, NAT, endpoint or address: the Data API needs none of them.
    for (const type of [
      'aws:ec2/internetGateway:InternetGateway',
      'aws:ec2/natGateway:NatGateway',
      'aws:ec2/vpcEndpoint:VpcEndpoint',
      'aws:ec2/eip:Eip',
    ]) {
      expect(fake.ofType(type), type).toEqual([]);
    }
  });

  it('[PLAT-5] uses the default security group, which `removal: retain` keeps beside the retained cluster', () => {
    runStack(fake);
    // A new security group would be deleted by `sst remove` while the retained cluster still used it.
    expect(fake.ofType('aws:ec2/securityGroup:SecurityGroup')).toEqual([]);
    only('aws:ec2/defaultSecurityGroup:DefaultSecurityGroup');
  });
});

describe('the not-paused alarm', () => {
  it('[OPS-7] notifies the alert topic when the cluster has not paused for 12 consecutive hours', () => {
    runStack(fake);
    const alarm = only('aws:cloudwatch/metricAlarm:MetricAlarm');
    const topic = only('aws:sns/topic:Topic');
    expect(NOT_PAUSED_HOURS).toBe(12);
    expect(alarm.args).toMatchObject({
      name: NOT_PAUSED_ALARM,
      namespace: 'AWS/RDS',
      metricName: 'ServerlessDatabaseCapacity',
      dimensions: { DBClusterIdentifier: only('sst:aws:Aurora').name },
      // An hour whose lowest capacity is above 0 is an hour the cluster never paused.
      statistic: 'Minimum',
      threshold: 0,
      comparisonOperator: 'GreaterThanThreshold',
      treatMissingData: 'notBreaching',
      alarmActions: [arn(topic)],
    });
    // Twelve one-hour periods, every one of them breaching.
    expect(Number(alarm.args.period) * Number(alarm.args.evaluationPeriods)).toBe(12 * 3600);
    expect(alarm.args.datapointsToAlarm).toBe(alarm.args.evaluationPeriods);
  });
});
