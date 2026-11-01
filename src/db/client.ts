import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { drizzle, type AwsDataApiPgDatabase } from 'drizzle-orm/aws-data-api/pg';
import { z } from 'zod';
import * as schema from './schema';
import { waitOutResumes, type ResumeOptions } from './resume';

/**
 * The one database module deployed code uses: Drizzle over the RDS Data API ([PLAT-9]).
 *
 * Nothing deployed opens a TCP connection to the database, so the cluster sits in a VPC nothing
 * can reach, and it pauses when no call has come for five minutes. Every call waits out a
 * resume from that pause ([PLAT-10], `./resume.ts`). Only tests use Drizzle's TCP driver, against
 * the PostgreSQL the project-setup hook starts.
 */

/** What the Data API needs to reach the cluster: the `Database` resource SST links. */
export const DatabaseResource = z.object({
  clusterArn: z.string().startsWith('arn:'),
  secretArn: z.string().startsWith('arn:'),
  database: z.string().min(1),
});
export type DatabaseResource = z.infer<typeof DatabaseResource>;

/** A Data API statement may run for up to 45 seconds; a request that outlasts that is lost. */
export const REQUEST_TIMEOUT_MS = 50_000;

export type Database = AwsDataApiPgDatabase<typeof schema>;

export function connectDatabase(resource: DatabaseResource, options: ResumeOptions & { client?: RDSDataClient } = {}): Database {
  const { clusterArn, secretArn, database } = DatabaseResource.parse(resource);
  // The cluster's own region, from its ARN, wherever the caller runs.
  const region = clusterArn.split(':')[3];
  const client = waitOutResumes(
    options.client ??
      new RDSDataClient({ region, requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: 5_000 } }),
    options,
  );
  return drizzle(client, { resourceArn: clusterArn, secretArn, database, schema });
}
