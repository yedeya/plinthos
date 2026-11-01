/**
 * The cost guards: refusals every resource of the stack passes, SST's own included.
 *
 * Each is a transform on a resource type, so it sees every resource of that type the program
 * creates, whether this repository's code creates it or a component such as `sst.aws.Nextjs`
 * does. A refused resource fails the deploy, before anything is created, with the clause that
 * refuses it. `tests/infra/cost-guards.test.ts` holds each one to its clause.
 *
 * - [PLAT-5]: no NAT gateway, no Elastic IP or other public IPv4 address, no VPC interface
 *   endpoint, no customer-managed KMS key, and no Lambda function attached to a VPC. A public
 *   IPv4 address (about $3.65 a month each) is refused on every resource type `registerGuards`
 *   names: where AWS falls back to a default that can be public, such as an instance taking its
 *   subnet's, the argument must turn the address off; where AWS's default is private, only an
 *   argument that turns it on is refused; a type that launches instances with no argument to stop
 *   them taking their subnet's address is refused whole. Left unguarded on purpose:
 *   - a launch template or launch configuration the stack doesn't create, referenced by id or
 *     name from an auto scaling group, an EC2 fleet or a spot fleet. A transform sees only the
 *     reference, not the template's network interfaces; one the stack creates is guarded.
 *   - a public endpoint whose address AWS holds in its own network, not in this account: App
 *     Runner's `isPubliclyAccessible`, a SageMaker notebook's `directInternetAccess` and Neptune
 *     Analytics' `publicConnectivity`.
 *   - a Batch job definition's `assignPublicIp`, inside a JSON document: its address exists only
 *     while a job runs, so nothing is billed at rest.
 * - [PLAT-7]: no recurring schedule. A schedule needs a cost estimate first (AGENTS.md §3),
 *   because one that reaches the database keeps Aurora awake; lift this refusal only with it.
 * - Every log group keeps 30 days (brief #6, Issue C).
 */

/** How long every log group keeps its events, in days. */
export const LOG_RETENTION_DAYS = 30;

export class GuardRefusal extends Error {
  override name = 'GuardRefusal';
}

const REASONS: Record<'[PLAT-5]' | '[PLAT-7]', string> = {
  '[PLAT-5]': 'it costs money at rest',
  '[PLAT-7]': 'a schedule that reaches the database keeps Aurora awake, so each one needs a cost estimate first',
};

function refuse(clause: keyof typeof REASONS, what: string, name: string): never {
  throw new GuardRefusal(`${clause} refuses ${what} ("${name}"): ${REASONS[clause]} (AGENTS.md §3).`);
}

type Args = Readonly<Record<string, unknown>> | undefined;
type ResourceClass = new (name: string, args: never) => unknown;

/** Refuses every resource of each type whose arguments `refused` picks out. */
function refuseWhere(types: readonly ResourceClass[], refused: (args: Args) => boolean, what: string): void {
  for (const type of types) {
    // Each type has its own arguments; the guard reads them only as unknown values.
    $transform<unknown, never, unknown>(type, (args: Args, _opts, name) => {
      if (refused(args)) refuse('[PLAT-5]', what, name);
    });
  }
}

/**
 * Whether a flag says no public address. An address only a deploy can resolve counts as public:
 * the guard can't see it now.
 */
function off(flag: unknown): boolean {
  return flag === false || flag === 'false' || flag === 'DISABLED';
}

/** Whether a flag whose default is private asks for a public address. */
function on(flag: unknown): boolean {
  return flag !== undefined && !off(flag);
}

/** The value at `path` in nested arguments; an output on the way stands in for whatever it holds. */
function at(value: unknown, ...path: string[]): unknown {
  for (const key of path) {
    if (value === undefined || value === null) return undefined;
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Registers every guard. `sst.config.ts`'s `run()` calls it before it creates anything. */
export function registerGuards(): void {
  $transform(aws.ec2.NatGateway, (_args, _opts, name) => refuse('[PLAT-5]', 'a NAT gateway', name));
  $transform(aws.ec2.Eip, (_args, _opts, name) => refuse('[PLAT-5]', 'an Elastic IP', name));
  // An instance left to its subnet's default gets a public address in every default-VPC subnet
  // and every public subnet `sst.aws.Vpc` makes, so it must turn the address off itself.
  refuseWhere(
    [aws.ec2.Instance, aws.ec2.SpotInstanceRequest, aws.ec2.LaunchConfiguration],
    (args) => !off(args?.associatePublicIpAddress),
    'an instance without associatePublicIpAddress: false',
  );
  // A template with no network interface of its own leaves the instances an auto scaling group
  // or a fleet launches from it to their subnet's default.
  refuseWhere(
    [aws.ec2.LaunchTemplate],
    (args) => {
      const interfaces = at(args, 'networkInterfaces');
      if (!Array.isArray(interfaces) || interfaces.length === 0) return true;
      return !interfaces.every((networkInterface) => off(at(networkInterface, 'associatePublicIpAddress')));
    },
    'a launch template without associatePublicIpAddress: false on every network interface',
  );
  // A fleet's own instance specifications take their subnet's default; one built from launch
  // templates is held by the template's guard.
  refuseWhere(
    [aws.ec2.SpotFleetRequest],
    (args) => at(args, 'launchSpecifications') !== undefined,
    'a spot fleet that specifies its own instances, which take their subnet’s public IPv4 address',
  );
  refuseWhere([aws.ec2.Subnet], (args) => on(args?.mapPublicIpOnLaunch), 'a subnet that maps a public IPv4 address on launch');
  // A default subnet maps one unless it is told not to.
  refuseWhere([aws.ec2.DefaultSubnet], (args) => !off(args?.mapPublicIpOnLaunch), 'a subnet that maps a public IPv4 address on launch');
  // AWS gives a task no public address unless it is asked to, as `sst.aws.Service` does in an SST VPC.
  const task = 'a task with a public IPv4 address';
  refuseWhere([aws.ecs.Service, aws.ecs.TaskSet], (args) => on(at(args, 'networkConfiguration', 'assignPublicIp')), task);
  refuseWhere([aws.cloudwatch.EventTarget], (args) => on(at(args, 'ecsTarget', 'networkConfiguration', 'assignPublicIp')), task);
  refuseWhere(
    [aws.pipes.Pipe],
    (args) => on(at(args, 'targetParameters', 'ecsTaskParameters', 'networkConfiguration', 'awsVpcConfiguration', 'assignPublicIp')),
    task,
  );
  // A load balancer is internet-facing unless it is internal.
  refuseWhere(
    [aws.lb.LoadBalancer, aws.alb.LoadBalancer, aws.elb.LoadBalancer],
    (args) => args?.internal !== true,
    'an internet-facing load balancer',
  );
  // Every type the provider gives `publiclyAccessible`. Left unset, AWS can make one public in a
  // VPC with an internet gateway, so it must be turned off; `infra/database.ts` does for Aurora's.
  refuseWhere(
    [
      aws.dms.ReplicationInstance,
      aws.docdb.ClusterInstance,
      aws.lightsail.Database,
      aws.m2.Environment,
      aws.mq.Broker,
      aws.neptune.ClusterInstance,
      aws.rds.ClusterInstance,
      aws.rds.Instance,
      aws.rds.ShardGroup,
      aws.redshift.Cluster,
      aws.redshiftserverless.Workgroup,
      aws.timestreaminfluxdb.DbCluster,
      aws.timestreaminfluxdb.DbInstance,
    ],
    (args) => !off(args?.publiclyAccessible),
    'a publicly accessible database or broker (set publiclyAccessible: false)',
  );
  refuseWhere(
    [aws.lightsail.Instance, aws.lightsail.Lb],
    (args) => args?.ipAddressType !== 'ipv6',
    'a Lightsail resource with a public IPv4 address',
  );
  refuseWhere([aws.lightsail.StaticIp], () => true, 'a Lightsail static IP');
  refuseWhere(
    [aws.globalaccelerator.Accelerator, aws.globalaccelerator.CustomRoutingAccelerator],
    () => true,
    'a Global Accelerator, which holds static public IPv4 addresses',
  );
  // `SERVICE_PROVIDED_EIPS` gives every broker an Elastic IP. AWS takes it only on an update, which
  // the guard sees as well.
  refuseWhere(
    [aws.msk.Cluster],
    (args) => on(at(args, 'brokerNodeGroupInfo', 'connectivityInfo', 'publicAccess', 'type')),
    'an MSK cluster with public access',
  );
  refuseWhere(
    [aws.appstream.Fleet, aws.appstream.ImageBuilder],
    (args) => on(args?.enableDefaultInternetAccess),
    'an AppStream fleet or image builder with default internet access, which gives each instance a public IPv4 address',
  );
  refuseWhere(
    [aws.workspaces.Directory],
    (args) => on(at(args, 'workspaceCreationProperties', 'enableInternetAccess')),
    'a WorkSpaces directory with internet access, which gives each WorkSpace a public IPv4 address',
  );
  // A connection's tunnels have public outside addresses unless they run over Direct Connect.
  refuseWhere(
    [aws.ec2.VpnConnection],
    (args) => args?.outsideIpAddressType !== 'PrivateIpv4',
    'a VPN connection with public IPv4 tunnel addresses (set outsideIpAddressType: "PrivateIpv4")',
  );
  refuseWhere(
    [aws.ec2clientvpn.Endpoint],
    (args) => args?.endpointIpAddressType !== 'ipv6',
    'a Client VPN endpoint with public IPv4 addresses (set endpointIpAddressType: "ipv6")',
  );
  refuseWhere(
    [aws.drs.ReplicationConfigurationTemplate],
    (args) => !off(args?.createPublicIp),
    'a disaster recovery template without createPublicIp: false',
  );
  // Amazon bills every address of a contiguous block it provides, used or not; a pool of the
  // owner's own addresses (BYOIP, AWS's default) or of IPv6 addresses costs nothing.
  refuseWhere(
    [aws.ec2.VpcIpamPool],
    (args) => args?.addressFamily !== 'ipv6' && args?.publicIpSource !== undefined && args.publicIpSource !== 'byoip',
    'an IPAM pool of Amazon-provided public IPv4 addresses',
  );
  // These launch instances that take their subnet's default and have no argument to stop it.
  refuseWhere([aws.eks.NodeGroup], () => true, 'an EKS node group, whose instances take their subnet’s public IPv4 address');
  refuseWhere([aws.emr.Cluster], () => true, 'an EMR cluster, whose instances take their subnet’s public IPv4 address');
  // A Fargate environment's jobs get no public address unless their job definition asks for one.
  refuseWhere(
    [aws.batch.ComputeEnvironment],
    (args) => {
      const computeResources = at(args, 'computeResources');
      if (computeResources === undefined) return false;
      const type = at(computeResources, 'type');
      return type !== 'FARGATE' && type !== 'FARGATE_SPOT';
    },
    'a Batch compute environment of EC2 or Spot instances, which take their subnet’s public IPv4 address',
  );
  refuseWhere(
    [aws.elasticbeanstalk.Environment],
    () => true,
    'an Elastic Beanstalk environment, whose instances take their subnet’s public IPv4 address and whose single-instance environments hold an Elastic IP',
  );
  $transform(aws.ec2.VpcEndpoint, (args, _opts, name) => {
    // Gateway endpoints (S3, DynamoDB), AWS's default kind, cost nothing; every other kind is
    // billed by the hour.
    if ((args.vpcEndpointType ?? 'Gateway') !== 'Gateway') refuse('[PLAT-5]', 'a VPC interface endpoint', name);
  });
  $transform(aws.kms.Key, (_args, _opts, name) => refuse('[PLAT-5]', 'a customer-managed KMS key', name));
  $transform(aws.kms.ReplicaKey, (_args, _opts, name) => refuse('[PLAT-5]', 'a customer-managed KMS key', name));
  $transform(aws.kms.ExternalKey, (_args, _opts, name) => refuse('[PLAT-5]', 'a customer-managed KMS key', name));
  $transform(aws.lambda.Function, (args, _opts, name) => {
    if (args.vpcConfig !== undefined) refuse('[PLAT-5]', 'a Lambda function attached to a VPC', name);
  });
  $transform(aws.cloudwatch.EventRule, (args, _opts, name) => {
    if (args?.scheduleExpression !== undefined) refuse('[PLAT-7]', 'a recurring schedule', name);
  });
  $transform(aws.scheduler.Schedule, (_args, _opts, name) => refuse('[PLAT-7]', 'a recurring schedule', name));
  $transform(aws.cloudwatch.LogGroup, (args) => {
    if (args !== undefined) args.retentionInDays = LOG_RETENTION_DAYS;
  });
}
