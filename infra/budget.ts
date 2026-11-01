/**
 * The account's monthly cost budget ([PLAT-6]): it notifies the alert topic when actual spend
 * passes 80% of the limit and when forecast spend passes 100% of it. Both rows of
 * `docs/observability.md`'s paged table are these two notifications ([OPS-3]).
 *
 * The budget has no cost filter, so it measures the whole member account, which holds nothing
 * but this deployment. AWS Budgets charges nothing for it.
 */

/** The two notifications, each with the signal name its paged row leads with. */
export const BUDGET_NOTIFICATIONS = [
  { signal: 'budget.actual.80', notificationType: 'ACTUAL', threshold: 80 },
  { signal: 'budget.forecast.100', notificationType: 'FORECASTED', threshold: 100 },
] as const;

export function createBudget(args: {
  limitUsd: number;
  topicArn: $util.Input<string>;
  dependsOn: $util.Resource[];
}) {
  return new aws.budgets.Budget(
    'Budget',
    {
      name: `${$app.name}-${$app.stage}`,
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      limitAmount: args.limitUsd.toFixed(2),
      limitUnit: 'USD',
      notifications: BUDGET_NOTIFICATIONS.map(({ notificationType, threshold }) => ({
        notificationType,
        threshold,
        thresholdType: 'PERCENTAGE',
        comparisonOperator: 'GREATER_THAN',
        subscriberSnsTopicArns: [args.topicArn],
      })),
    },
    // The topic's policy must let Budgets publish before the budget points at it.
    { dependsOn: args.dependsOn },
  );
}
