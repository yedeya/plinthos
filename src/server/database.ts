/**
 * The deployed database, for the service core: Drizzle over the Data API (`src/db/client.ts`),
 * reached through the `Database` resource `infra/admin.ts` links to the server function.
 *
 * It connects on the first call, never on import, so a module that imports it costs nothing until
 * it really needs the database: an anonymous request is refused before that ([AUTH-6]). Tests
 * replace this module with one over the test database.
 */
import { Resource } from 'sst/resource';
import { connectDatabase, type Database } from '../db/client';

export type { Database };

let connected: Database | undefined;

/** The database, connected on first use. */
export function database(): Database {
  connected ??= connectDatabase((Resource as unknown as { Database: Parameters<typeof connectDatabase>[0] }).Database);
  return connected;
}
