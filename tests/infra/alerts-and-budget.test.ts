import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeSst, FAKE_ACCOUNT, type FakeSst } from './fake-sst';
import { deploymentEnv, runStack } from './harness';

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

interface Statement {
  Principal: { Service: string };
  Action: string;
  Resource: string;
  Condition: { StringEquals: Record<string, string> };
}

function only(type: string) {
  const found = fake.ofType(type);
  expect(found, type).toHaveLength(1);
  const [resource] = found;
  if (resource === undefined) throw new Error(`no ${type}`);
  return resource;
}

describe('the alert topic', () => {
  it('[OPS-4] is one SNS topic, which e-mails the address the AlertEmail secret holds', () => {
    runStack(fake);
    const topic = only('aws:sns/topic:Topic');
    const subscription = only('aws:sns/topicSubscription:TopicSubscription');
    expect(subscription.args).toEqual({
      topic: `arn:fake:aws:sns/topic:Topic:${topic.name}`,
      protocol: 'email',
      endpoint: 'fake-secret:AlertEmail',
    });
  });

  it('[OPS-4] lets AWS Budgets and CloudWatch alarms of this account, and of no other, publish to it', () => {
    runStack(fake);
    const topicArn = `arn:fake:aws:sns/topic:Topic:${only('aws:sns/topic:Topic').name}`;
    const policy = only('aws:sns/topicPolicy:TopicPolicy');
    expect(policy.args.arn).toBe(topicArn);
    const statements = (JSON.parse(String(policy.args.policy)) as { Statement: Statement[] }).Statement;
    expect(statements.map((statement) => statement.Principal.Service).sort()).toEqual([
      'budgets.amazonaws.com',
      'cloudwatch.amazonaws.com',
    ]);
    for (const statement of statements) {
      expect(statement.Action).toBe('SNS:Publish');
      expect(statement.Resource).toBe(topicArn);
      expect(statement.Condition).toEqual({ StringEquals: { 'aws:SourceAccount': FAKE_ACCOUNT } });
    }
  });

  it('[OPS-4] every budget notification and every alarm notifies that one topic', () => {
    runStack(fake);
    const topicArn = `arn:fake:aws:sns/topic:Topic:${only('aws:sns/topic:Topic').name}`;
    const notifications = only('aws:budgets/budget:Budget').args.notifications as { subscriberSnsTopicArns: string[] }[];
    for (const notification of notifications) expect(notification.subscriberSnsTopicArns).toEqual([topicArn]);
    for (const alarm of fake.ofType('aws:cloudwatch/metricAlarm:MetricAlarm')) {
      expect(alarm.args.alarmActions, alarm.name).toEqual([topicArn]);
    }
  });
});

describe('the budget', () => {
  it('[PLAT-6] is a monthly cost budget on the whole account, at the $10 default limit', () => {
    runStack(fake);
    const budget = only('aws:budgets/budget:Budget');
    expect(budget.args).toMatchObject({
      name: 'plinthos-production',
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      limitAmount: '10.00',
      limitUnit: 'USD',
    });
    expect(budget.args).not.toHaveProperty('costFilters');
    expect(budget.args).not.toHaveProperty('autoAdjustData');
  });

  it('[PLAT-6] takes its limit from the deployment’s configuration', () => {
    runStack(fake, deploymentEnv({ PLINTHOS_BUDGET_LIMIT_USD: '25.5' }));
    expect(only('aws:budgets/budget:Budget').args.limitAmount).toBe('25.50');
  });

  it('[PLAT-6] notifies the alert topic at 80% of actual spend and at 100% of forecast spend', () => {
    runStack(fake);
    const notifications = only('aws:budgets/budget:Budget').args.notifications as Record<string, unknown>[];
    expect(notifications.map(({ notificationType, threshold, thresholdType, comparisonOperator }) => ({
      notificationType,
      threshold,
      thresholdType,
      comparisonOperator,
    }))).toEqual([
      { notificationType: 'ACTUAL', threshold: 80, thresholdType: 'PERCENTAGE', comparisonOperator: 'GREATER_THAN' },
      { notificationType: 'FORECASTED', threshold: 100, thresholdType: 'PERCENTAGE', comparisonOperator: 'GREATER_THAN' },
    ]);
  });

  it('[PLAT-6] is created after the topic policy that lets Budgets publish', () => {
    runStack(fake);
    const policy = only('aws:sns/topicPolicy:TopicPolicy');
    expect(only('aws:budgets/budget:Budget').opts?.dependsOn).toEqual([policy.instance]);
  });
});
