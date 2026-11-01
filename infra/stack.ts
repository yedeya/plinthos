import { createAdmin, LINKED_SECRETS } from './admin';
import { createAlertTopic } from './alerts';
import { createLoginAttempts } from './auth';
import { createBudget } from './budget';
import { createDatabase, createNotPausedAlarm } from './database';
import { assertSecretsSet, SECRETS, type DeploymentConfig } from './config';
import { registerGuards } from './guards';
import { createSnapshot } from './snapshot';

/**
 * The whole stack, in the order it is built. `sst.config.ts`'s `run()` calls it.
 *
 * It holds what brief #6's §4 prices: the alert topic and its e-mail subscription, the budget,
 * the admin's shell, the database with its free VPC and its not-paused alarm, the login rate
 * limiter's on-demand table, and the public snapshot's bucket and distribution. Every SST secret
 * is declared, so a deploy with one unset fails and names it ([PLAT-2]). The admin is linked to
 * the sign-in's secrets, the database and the rate limiter's table (#16), and to the snapshot,
 * which it publishes (#19).
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
  const loginAttempts = createLoginAttempts();
  const linkedSecrets = LINKED_SECRETS.map((name) => {
    const secret = secrets.get(name);
    if (secret === undefined) throw new Error(`infra/config.ts declares no ${name} secret`);
    return secret;
  });
  const snapshot = createSnapshot();
  const admin = createAdmin({
    link: [...linkedSecrets, database, loginAttempts, snapshot.link],
    sessionIdleDays: config.sessionIdleDays,
    sessionAbsoluteDays: config.sessionAbsoluteDays,
    loginAttemptsPerAddress: config.loginAttemptsPerAddress,
    loginAttemptsTotal: config.loginAttemptsTotal,
  });

  // Printed at the end of every deploy, in public logs: the admin's address and the catalogue's
  // host, never an ARN (an ARN holds the account ID) and never the token, which a catalogue's
  // address also needs and only the admin shows after a publish. The deploy hook hands the
  // admin's address to the smoke check. The migration step reads the database's ARNs from
  // `sst shell`'s environment instead (docs/deploy.md).
  return { adminUrl: admin.url, catalogueHost: snapshot.link.properties.url };
}
