/**
 * The cost guards: refusals every resource of the stack passes, SST's own included.
 *
 * Each is a transform on a resource type, so it sees every resource of that type the program
 * creates, whether this repository's code creates it or a component such as `sst.aws.Nextjs`
 * does. A refused resource fails the deploy, before anything is created, with the clause that
 * refuses it. `tests/infra/guards.test.ts` holds each one to its clause.
 *
 * - [PLAT-5]: no NAT gateway, no Elastic IP or other public IPv4 address, no VPC interface
 *   endpoint, no customer-managed KMS key, and no Lambda function attached to a VPC.
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

/** Registers every guard. `sst.config.ts`'s `run()` calls it before it creates anything. */
export function registerGuards(): void {
  $transform(aws.ec2.NatGateway, (_args, _opts, name) => refuse('[PLAT-5]', 'a NAT gateway', name));
  $transform(aws.ec2.Eip, (_args, _opts, name) => refuse('[PLAT-5]', 'an Elastic IP', name));
  $transform(aws.ec2.Instance, (args, _opts, name) => {
    // An address only a deploy can resolve counts as public: the guard can't see it now.
    if (args?.associatePublicIpAddress !== undefined && args.associatePublicIpAddress !== false) {
      refuse('[PLAT-5]', 'an instance with a public IPv4 address', name);
    }
  });
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
