import { createAdmin } from './admin';
import { createAlertTopic } from './alerts';
import { createBudget } from './budget';
import { createDatabase, createNotPausedAlarm } from './database';
import { assertSecretsSet, SECRETS, type DeploymentConfig } from './config';
import { registerGuards } from './guards';

/**
 * The whole stack, in the order it is built. `sst.config.ts`'s `run()` calls it.
 *
 * It holds what brief #6's §4 prices: the alert topic and its e-mail subscription, the budget,
 * the admin's shell, and the database with its free VPC and its not-paused alarm. Every SST
 * secret is declared, so a deploy with one unset fails and names it ([PLAT-2]); the admin's
 * account and the session secret are declared here and first read by the sign-in (#16), which
 * also links the database to the admin.
 */
export function defineStack(config: DeploymentConfig, env: Readonly<Record<string, string | undefined>>) {
  assertSecretsSet(env);
  registerGuards();

  const secrets = new Map(SECRETS.map(({ name }) => [name, new sst.Secret(name)]));
  const alertEmail = secrets.get('AlertEmail');
  if (alertEmail === undefined) throw new Error('infra/config.ts declares no AlertEmail secret');

  const alerts = createAlertTopic(alertEmail.value);
  createBudget({ limitUsd: config.budgetLimitUsd, topicArn: alerts.topic.arn, dependsOn: [alerts.policy] });
  const { database } = createDatabase({ maxAcu: config.auroraMaxAcu });
  createNotPausedAlarm({ clusterId: database.id, topicArn: alerts.topic.arn });
  const admin = createAdmin();

  // Printed at the end of every deploy, in public logs: the admin's address only, never an ARN
  // (an ARN holds the account ID). The deploy hook hands it to the smoke check. The migration
  // step reads the database's ARNs from `sst shell`'s environment instead (docs/deploy.md).
  return { adminUrl: admin.url };
}
