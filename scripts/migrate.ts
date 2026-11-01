/**
 * The deploy's migration step ([PLAT-12]): applies every pending migration through the RDS Data
 * API, never over TCP ([PLAT-9]). Run it after `sst deploy` and before the smoke check, inside
 * `sst shell`, which hands it the deployed `Database` resource without printing its ARNs:
 *
 *   npx sst shell --stage production -- npm run db:migrate
 *
 * It needs the deployer's AWS credentials, and nothing inside the VPC. A paused cluster resumes
 * on the first call, which the database module waits out ([PLAT-10]).
 */
import { migrate } from 'drizzle-orm/aws-data-api/pg/migrator';
import { Resource } from 'sst';
import { connectDatabase, DatabaseResource } from '../src/db/client';
import { applyMigrations } from '../src/db/migrate';
import { logger } from '../src/server/logger';

function linkedDatabase(): unknown {
  try {
    return (Resource as unknown as Record<string, unknown>).Database;
  } catch {
    // SST's `Resource` throws for a resource the environment does not hold.
    return undefined;
  }
}

const resource = DatabaseResource.safeParse(linkedDatabase());
if (!resource.success) {
  logger.error(
    { event: 'db.migrate.unlinked' },
    'No deployed Database resource: run this inside `npx sst shell --stage production --`, after `sst deploy` (docs/deploy.md).',
  );
  process.exit(1);
}
const { applied, total } = await applyMigrations(connectDatabase(resource.data), migrate);
logger.info({ event: 'db.migrated', applied, total }, `applied ${applied} migration(s), ${total} in all`);
