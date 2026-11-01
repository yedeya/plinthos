/**
 * The one alert topic ([OPS-4]): every alarm and the budget notify it, and it e-mails the address
 * the `AlertEmail` secret holds. `docs/observability.md` says what each signal on it means.
 *
 * The topic is not encrypted with a customer-managed key ([PLAT-5]). Its policy lets AWS Budgets
 * and CloudWatch alarms of this account, and no other account, publish to it.
 */
export function createAlertTopic(alertEmail: $util.Input<string>) {
  const account = aws.getCallerIdentityOutput({}).accountId;
  const topic = new aws.sns.Topic('Alerts', {});
  const fromThisAccount = { StringEquals: { 'aws:SourceAccount': account } };
  const policy = new aws.sns.TopicPolicy('AlertsPolicy', {
    arn: topic.arn,
    policy: $jsonStringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'BudgetsPublish',
          Effect: 'Allow',
          Principal: { Service: 'budgets.amazonaws.com' },
          Action: 'SNS:Publish',
          Resource: topic.arn,
          Condition: fromThisAccount,
        },
        {
          Sid: 'CloudWatchAlarmsPublish',
          Effect: 'Allow',
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: 'SNS:Publish',
          Resource: topic.arn,
          Condition: fromThisAccount,
        },
      ],
    }),
  });
  // E-mail subscriptions start pending: the address confirms it from the first message
  // (docs/deploy.md), and docs/observability.md tracks that hand step.
  new aws.sns.TopicSubscription('AlertsEmail', { topic: topic.arn, protocol: 'email', endpoint: alertEmail });
  return { topic, policy };
}
