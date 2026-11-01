/**
 * Stand-ins for the globals SST gives `sst.config.ts` and `infra/` (`sst`, `aws`, `$transform`,
 * `$config`, `$app`, `$jsonStringify`), so the tests can run the stack's code with no AWS and no
 * Pulumi engine. Every resource the code constructs is recorded with its type token, logical
 * name, arguments and options, in order; every `$transform` is recorded with its type token.
 *
 * The stand-ins resolve outputs to plain values: an ARN is `arn:fake:<token>:<name>`, an id is
 * the logical name, a secret's value is `fake-secret:<name>`, the account is the made-up
 * `000000000000`, and the zones are `FAKE_ZONES`.
 */

export interface RecordedResource {
  type: string;
  name: string;
  args: Record<string, unknown>;
  opts: Record<string, unknown> | undefined;
  /** The instance the code received, so a test can match references to it. */
  instance: object;
}

export interface RecordedTransform {
  type: string;
  callback: (args: Record<string, unknown> | undefined, opts: Record<string, unknown>, name: string) => void;
}

export interface FakeSst {
  /** Every event in order: a transform registration or a resource construction. */
  events: ({ kind: 'transform'; type: string } | { kind: 'resource'; type: string; name: string })[];
  resources: RecordedResource[];
  transforms: RecordedTransform[];
  ofType(type: string): RecordedResource[];
  uninstall(): void;
}

export const FAKE_ACCOUNT = '000000000000';

/** The made-up availability zones `aws.getAvailabilityZonesOutput` answers with. */
export const FAKE_ZONES = ['fake-zone-a', 'fake-zone-b', 'fake-zone-c'];

/** The Pulumi type tokens of every class the stand-in `aws` namespace holds, by path. */
const AWS_CLASSES: Record<string, string> = {
  'alb.LoadBalancer': 'aws:alb/loadBalancer:LoadBalancer',
  'budgets.Budget': 'aws:budgets/budget:Budget',
  'cloudwatch.EventRule': 'aws:cloudwatch/eventRule:EventRule',
  'cloudwatch.EventTarget': 'aws:cloudwatch/eventTarget:EventTarget',
  'cloudwatch.LogGroup': 'aws:cloudwatch/logGroup:LogGroup',
  'cloudwatch.MetricAlarm': 'aws:cloudwatch/metricAlarm:MetricAlarm',
  'dms.ReplicationInstance': 'aws:dms/replicationInstance:ReplicationInstance',
  'docdb.ClusterInstance': 'aws:docdb/clusterInstance:ClusterInstance',
  'ec2.DefaultSecurityGroup': 'aws:ec2/defaultSecurityGroup:DefaultSecurityGroup',
  'ec2.DefaultSubnet': 'aws:ec2/defaultSubnet:DefaultSubnet',
  'ec2.Eip': 'aws:ec2/eip:Eip',
  'ec2.Instance': 'aws:ec2/instance:Instance',
  'ec2.InternetGateway': 'aws:ec2/internetGateway:InternetGateway',
  'ec2.LaunchConfiguration': 'aws:ec2/launchConfiguration:LaunchConfiguration',
  'ec2.LaunchTemplate': 'aws:ec2/launchTemplate:LaunchTemplate',
  'ec2.NatGateway': 'aws:ec2/natGateway:NatGateway',
  'ec2.SpotFleetRequest': 'aws:ec2/spotFleetRequest:SpotFleetRequest',
  'ec2.SpotInstanceRequest': 'aws:ec2/spotInstanceRequest:SpotInstanceRequest',
  'ec2.Subnet': 'aws:ec2/subnet:Subnet',
  'ec2.Vpc': 'aws:ec2/vpc:Vpc',
  'ec2.VpcEndpoint': 'aws:ec2/vpcEndpoint:VpcEndpoint',
  'ecs.Service': 'aws:ecs/service:Service',
  'ecs.TaskSet': 'aws:ecs/taskSet:TaskSet',
  'elb.LoadBalancer': 'aws:elb/loadBalancer:LoadBalancer',
  'globalaccelerator.Accelerator': 'aws:globalaccelerator/accelerator:Accelerator',
  'globalaccelerator.CustomRoutingAccelerator': 'aws:globalaccelerator/customRoutingAccelerator:CustomRoutingAccelerator',
  'kms.ExternalKey': 'aws:kms/externalKey:ExternalKey',
  'kms.Key': 'aws:kms/key:Key',
  'kms.ReplicaKey': 'aws:kms/replicaKey:ReplicaKey',
  'lambda.Function': 'aws:lambda/function:Function',
  'lb.LoadBalancer': 'aws:lb/loadBalancer:LoadBalancer',
  'lightsail.Database': 'aws:lightsail/database:Database',
  'lightsail.Instance': 'aws:lightsail/instance:Instance',
  'lightsail.Lb': 'aws:lightsail/lb:Lb',
  'lightsail.StaticIp': 'aws:lightsail/staticIp:StaticIp',
  'm2.Environment': 'aws:m2/environment:Environment',
  'mq.Broker': 'aws:mq/broker:Broker',
  'neptune.ClusterInstance': 'aws:neptune/clusterInstance:ClusterInstance',
  'pipes.Pipe': 'aws:pipes/pipe:Pipe',
  'rds.ClusterInstance': 'aws:rds/clusterInstance:ClusterInstance',
  'rds.Instance': 'aws:rds/instance:Instance',
  'rds.ShardGroup': 'aws:rds/shardGroup:ShardGroup',
  'redshift.Cluster': 'aws:redshift/cluster:Cluster',
  'redshiftserverless.Workgroup': 'aws:redshiftserverless/workgroup:Workgroup',
  'scheduler.Schedule': 'aws:scheduler/schedule:Schedule',
  'sns.Topic': 'aws:sns/topic:Topic',
  'sns.TopicPolicy': 'aws:sns/topicPolicy:TopicPolicy',
  'sns.TopicSubscription': 'aws:sns/topicSubscription:TopicSubscription',
  'timestreaminfluxdb.DbCluster': 'aws:timestreaminfluxdb/dbCluster:DbCluster',
  'timestreaminfluxdb.DbInstance': 'aws:timestreaminfluxdb/dbInstance:DbInstance',
};

const GLOBALS = ['sst', 'aws', '$transform', '$config', '$app', '$jsonStringify'] as const;

export function installFakeSst(): FakeSst {
  const fake: FakeSst = {
    events: [],
    resources: [],
    transforms: [],
    ofType: (type) => fake.resources.filter((resource) => resource.type === type),
    uninstall: () => {
      for (const name of GLOBALS) Reflect.deleteProperty(globalThis, name);
    },
  };

  function resourceClass(type: string, extra: (name: string, args: Record<string, unknown>) => object = () => ({})) {
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- its constructor records the resource
    const Resource = class {
      static __pulumiType = type;
      constructor(name: string, args: Record<string, unknown> = {}, opts?: Record<string, unknown>) {
        Object.assign(this, { arn: `arn:fake:${type}:${name}`, name, id: name }, extra(name, args));
        fake.resources.push({ type, name, args, opts, instance: this });
        fake.events.push({ kind: 'resource', type, name });
      }
    };
    return Resource;
  }

  const aws: Record<string, Record<string, unknown>> = {};
  for (const [path, type] of Object.entries(AWS_CLASSES)) {
    const [module, name] = path.split('.') as [string, string];
    aws[module] ??= {};
    aws[module][name] = resourceClass(type);
  }
  Object.assign(aws, {
    getCallerIdentityOutput: () => ({ accountId: FAKE_ACCOUNT }),
    getAvailabilityZonesOutput: () => ({ names: FAKE_ZONES }),
  });

  const sst = {
    Secret: resourceClass('sst:sst:Secret', (name) => ({ value: `fake-secret:${name}` })),
    aws: {
      Nextjs: resourceClass('sst:aws:Nextjs', () => ({ url: 'https://admin.example.test' })),
      Dynamo: resourceClass('sst:aws:Dynamo', (name) => ({ name: `fake-table-${name}` })),
      Aurora: resourceClass('sst:aws:Aurora', (name) => ({
        clusterArn: `arn:fake:aurora-cluster:${name}`,
        secretArn: `arn:fake:aurora-secret:${name}`,
      })),
    },
  };

  Object.assign(globalThis, {
    sst,
    aws,
    $app: { name: 'plinthos', stage: 'production' },
    $config: (config: unknown) => config,
    $jsonStringify: (value: unknown) => JSON.stringify(value),
    $transform: (resource: { __pulumiType: string }, callback: RecordedTransform['callback']) => {
      fake.transforms.push({ type: resource.__pulumiType, callback });
      fake.events.push({ kind: 'transform', type: resource.__pulumiType });
    },
  });
  return fake;
}

/** Every SST secret set, as `sst` hands them to the program. */
export function secretsEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [`SST_SECRET_${name}`, `fake-secret:${name}`]));
}
