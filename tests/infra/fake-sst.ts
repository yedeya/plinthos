/**
 * Stand-ins for the globals SST gives `sst.config.ts` and `infra/` (`sst`, `aws`, `$transform`,
 * `$config`, `$app`, `$jsonStringify`, `$interpolate`, `$output`), so the tests can run the
 * stack's code with no AWS and no Pulumi engine. Every resource the code constructs is recorded
 * with its type token, logical name, arguments and options, in order; every `$transform` is
 * recorded with its type token.
 *
 * The stand-ins resolve outputs to plain values: an ARN is `arn:fake:<token>:<name>`, an id is
 * the logical name, a secret's value is `fake-secret:<name>`, a bucket's name is
 * `fake-bucket-<name>` and a distribution's host `<name>.fake.cloudfront.test`, the account is the
 * made-up `000000000000`, and the zones are `FAKE_ZONES`. `$interpolate` joins its template, and
 * `$output(value).apply(callback)` answers `callback(value)`.
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
  'appstream.Fleet': 'aws:appstream/fleet:Fleet',
  'appstream.ImageBuilder': 'aws:appstream/imageBuilder:ImageBuilder',
  'batch.ComputeEnvironment': 'aws:batch/computeEnvironment:ComputeEnvironment',
  'budgets.Budget': 'aws:budgets/budget:Budget',
  'cloudfront.Distribution': 'aws:cloudfront/distribution:Distribution',
  'cloudfront.OriginAccessControl': 'aws:cloudfront/originAccessControl:OriginAccessControl',
  'cloudfront.ResponseHeadersPolicy': 'aws:cloudfront/responseHeadersPolicy:ResponseHeadersPolicy',
  'cloudwatch.EventRule': 'aws:cloudwatch/eventRule:EventRule',
  'cloudwatch.EventTarget': 'aws:cloudwatch/eventTarget:EventTarget',
  'cloudwatch.LogGroup': 'aws:cloudwatch/logGroup:LogGroup',
  'cloudwatch.MetricAlarm': 'aws:cloudwatch/metricAlarm:MetricAlarm',
  'dms.ReplicationInstance': 'aws:dms/replicationInstance:ReplicationInstance',
  'docdb.ClusterInstance': 'aws:docdb/clusterInstance:ClusterInstance',
  'drs.ReplicationConfigurationTemplate': 'aws:drs/replicationConfigurationTemplate:ReplicationConfigurationTemplate',
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
  'ec2.VpcIpamPool': 'aws:ec2/vpcIpamPool:VpcIpamPool',
  'ec2.VpnConnection': 'aws:ec2/vpnConnection:VpnConnection',
  'ec2clientvpn.Endpoint': 'aws:ec2clientvpn/endpoint:Endpoint',
  'ecs.Service': 'aws:ecs/service:Service',
  'ecs.TaskSet': 'aws:ecs/taskSet:TaskSet',
  'eks.Cluster': 'aws:eks/cluster:Cluster',
  'eks.NodeGroup': 'aws:eks/nodeGroup:NodeGroup',
  'elasticbeanstalk.Environment': 'aws:elasticbeanstalk/environment:Environment',
  'elb.LoadBalancer': 'aws:elb/loadBalancer:LoadBalancer',
  'emr.Cluster': 'aws:emr/cluster:Cluster',
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
  'msk.Cluster': 'aws:msk/cluster:Cluster',
  'neptune.ClusterInstance': 'aws:neptune/clusterInstance:ClusterInstance',
  'pipes.Pipe': 'aws:pipes/pipe:Pipe',
  'rds.ClusterInstance': 'aws:rds/clusterInstance:ClusterInstance',
  'rds.Instance': 'aws:rds/instance:Instance',
  'rds.ShardGroup': 'aws:rds/shardGroup:ShardGroup',
  'redshift.Cluster': 'aws:redshift/cluster:Cluster',
  'redshiftserverless.Workgroup': 'aws:redshiftserverless/workgroup:Workgroup',
  's3.Bucket': 'aws:s3/bucket:Bucket',
  's3.BucketCorsConfiguration': 'aws:s3/bucketCorsConfiguration:BucketCorsConfiguration',
  's3.BucketLifecycleConfiguration': 'aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration',
  's3.BucketPolicy': 'aws:s3/bucketPolicy:BucketPolicy',
  's3.BucketPublicAccessBlock': 'aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock',
  'scheduler.Schedule': 'aws:scheduler/schedule:Schedule',
  'sns.Topic': 'aws:sns/topic:Topic',
  'sns.TopicPolicy': 'aws:sns/topicPolicy:TopicPolicy',
  'sns.TopicSubscription': 'aws:sns/topicSubscription:TopicSubscription',
  'timestreaminfluxdb.DbCluster': 'aws:timestreaminfluxdb/dbCluster:DbCluster',
  'timestreaminfluxdb.DbInstance': 'aws:timestreaminfluxdb/dbInstance:DbInstance',
  'workspaces.Directory': 'aws:workspaces/directory:Directory',
};

const GLOBALS = ['sst', 'aws', '$transform', '$config', '$app', '$jsonStringify', '$interpolate', '$output'] as const;

/** What a resource of a type exposes beside its ARN, name and id. */
const EXTRAS: Record<string, (name: string) => object> = {
  'aws:s3/bucket:Bucket': (name) => ({ bucket: `fake-bucket-${name}`, bucketRegionalDomainName: `fake-bucket-${name}.s3.fake-region.test` }),
  'aws:cloudfront/distribution:Distribution': (name) => ({ domainName: `${name}.fake.cloudfront.test` }),
};

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
    aws[module][name] = resourceClass(type, EXTRAS[type]);
  }
  Object.assign(aws, {
    getCallerIdentityOutput: () => ({ accountId: FAKE_ACCOUNT }),
    getPartitionOutput: () => ({ partition: 'aws' }),
    getAvailabilityZonesOutput: () => ({ names: FAKE_ZONES }),
  });

  const sst = {
    Secret: resourceClass('sst:sst:Secret', (name) => ({ value: `fake-secret:${name}` })),
    Linkable: resourceClass('sst:sst:Linkable', (_name, args) => ({ properties: args.properties })),
    aws: {
      permission: (input: object) => ({ type: 'aws.permission', ...input }),
      Nextjs: resourceClass('sst:aws:Nextjs', () => ({ url: 'https://admin.example.test' })),
      Function: resourceClass('sst:aws:Function', (name, args) => ({ name: typeof args.name === 'string' ? args.name : `fake-function-${name}` })),
      CronV2: resourceClass('sst:aws:CronV2'),
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
    $output: (value: unknown) => ({ apply: (callback: (resolved: unknown) => unknown) => callback(value) }),
    $interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((joined, part, index) => `${joined}${part}${index < values.length ? String(values[index]) : ''}`, ''),
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
