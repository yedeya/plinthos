/**
 * The database: Aurora Serverless v2 PostgreSQL at a minimum of 0 ACU, so it pauses when idle,
 * with the RDS Data API and no network path to it at all ([PLAT-8]).
 *
 * Deployed code and the deploy's migration step reach it only through the Data API ([PLAT-9]),
 * an AWS API that IAM guards, so nothing needs to reach into its VPC. The VPC is therefore built
 * here from its free parts alone: two private subnets, the two zones an RDS subnet group needs,
 * and the VPC's default security group stripped of every rule. There is no internet gateway, no
 * NAT, no endpoint and no public address ([PLAT-5]). `sst.aws.Vpc` is not used, because it
 * always adds a Cloud Map namespace, whose private Route 53 zone is billed every month, and
 * public subnets that give an instance a public address.
 *
 * `removal: 'retain'` keeps the VPC, its subnets, its default security group, the cluster, its
 * parameter groups and its subnet group on `sst remove` (docs/deploy.md, "Tear it down"); that is
 * why the security group is the VPC's default one, which SST retains, rather than a new one the
 * retained cluster would still be using when `sst remove` deletes it. The cluster also has
 * deletion protection on ([PLAT-8]), so deleting it means switching that off first.
 *
 * At rest this costs the cluster's storage and its master-credential secret, which the Data API
 * reads (brief #6, §4). The alarm below pages when the cluster has not paused for 12 hours
 * ([OPS-7], decision 5).
 */

/** The VPC's address range, and one /24 per private subnet. Nothing in it is routable. */
export const VPC_CIDR = '10.0.0.0/16';
export const SUBNET_CIDRS = ['10.0.0.0/24', '10.0.1.0/24'] as const;

/** The name of the database the cluster holds, which the Data API's calls name. */
export const DATABASE_NAME = 'plinthos';

/**
 * The not-paused alarm's signal name, which is its CloudWatch name and its paged row in
 * `docs/observability.md` ([OPS-3], [OPS-7]).
 */
export const NOT_PAUSED_ALARM = 'aurora.not_paused';

/** How long the cluster may stay awake without a pause before the alarm pages ([OPS-7]). */
export const NOT_PAUSED_HOURS = 12;

/** How many days of point-in-time recovery Aurora keeps: its maximum ([PLAT-15], Owner, 2026-11-02). */
export const BACKUP_RETENTION_DAYS = 35;

export function createDatabase(args: { maxAcu: number }) {
  const zones = aws.getAvailabilityZonesOutput({ state: 'available' }).names;
  const vpc = new aws.ec2.Vpc('DatabaseVpc', {
    cidrBlock: VPC_CIDR,
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: { Name: `${$app.name}-${$app.stage}-database` },
  });
  const subnets = SUBNET_CIDRS.map(
    (cidrBlock, index) =>
      new aws.ec2.Subnet(`DatabaseSubnet${index + 1}`, {
        vpcId: vpc.id,
        cidrBlock,
        availabilityZone: zones[index],
        mapPublicIpOnLaunch: false,
        tags: { Name: `${$app.name}-${$app.stage}-database-${index + 1}` },
      }),
  );
  // No rule in either direction: nothing connects to the cluster over the network, and the Data
  // API does not need to.
  const securityGroup = new aws.ec2.DefaultSecurityGroup('DatabaseSecurityGroup', {
    vpcId: vpc.id,
    ingress: [],
    egress: [],
    tags: { Name: `${$app.name}-${$app.stage}-database` },
  });

  const database = new sst.aws.Aurora('Database', {
    engine: 'postgres',
    // Pinned, so a deploy never upgrades the engine unasked. Its major version is the test
    // database's, which tests/support/aurora.ts reads from this literal ([DEV-4]); a 0-ACU
    // minimum needs 16.3 or later in the 16 line.
    version: '16.8',
    database: DATABASE_NAME,
    scaling: { min: '0 ACU', max: `${args.maxAcu} ACU` },
    dataApi: true,
    vpc: { subnets: subnets.map((subnet) => subnet.id), securityGroups: [securityGroup.id] },
    transform: {
      // Neither a bad deploy that replaces the cluster nor a stray API call can delete the
      // catalogue's database until the owner switches this off (docs/deploy.md, "Tear it down").
      cluster: (cluster) => {
        cluster.deletionProtection = true;
        // Point-in-time recovery to any second of the last 35 days, the most Aurora keeps, so a
        // bad migration or a bug noticed late can still be undone ([PLAT-15]). Backup storage up
        // to the cluster's own size is free, and the catalogue is well under 1 GB.
        cluster.backupRetentionPeriod = BACKUP_RETENTION_DAYS;
      },
      // SST leaves both at AWS's default, which is already private; say so where it is checked.
      instance: (instance) => {
        instance.publiclyAccessible = false;
      },
    },
  });
  return { database, vpc, subnets, securityGroup };
}

/**
 * Pages when the cluster has not paused for 12 consecutive hours ([OPS-7]): at 0.5 ACU a cluster
 * that never pauses costs about $51 a month (brief #6, §4). `ServerlessDatabaseCapacity` is 0
 * while the cluster is paused, so an hour whose minimum is above 0 is an hour it never paused.
 * An hour with no data point is not counted against it.
 */
export function createNotPausedAlarm(args: { clusterId: $util.Input<string>; topicArn: $util.Input<string> }) {
  return new aws.cloudwatch.MetricAlarm('DatabaseNotPaused', {
    name: NOT_PAUSED_ALARM,
    alarmDescription: `The Aurora cluster has not paused for ${NOT_PAUSED_HOURS} hours: find what keeps it awake (docs/observability.md).`,
    namespace: 'AWS/RDS',
    metricName: 'ServerlessDatabaseCapacity',
    dimensions: { DBClusterIdentifier: args.clusterId },
    statistic: 'Minimum',
    period: 3600,
    evaluationPeriods: NOT_PAUSED_HOURS,
    datapointsToAlarm: NOT_PAUSED_HOURS,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    treatMissingData: 'notBreaching',
    alarmActions: [args.topicArn],
    okActions: [args.topicArn],
  });
}
