import pg from 'pg';
import { readDatabaseUrl } from '../../src/db/database-url';

/**
 * Connects to the test database at `DATABASE_URL`. It throws when the variable is unset and
 * rejects when the server does not answer within a few seconds, so a test that needs the
 * database fails without one rather than skipping ([DEV-3]).
 */
export async function connectTestDatabase(url: string = readDatabaseUrl()): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new Error(`the test database at DATABASE_URL does not answer: ${(error as Error).message}`, { cause: error });
  }
  return client;
}
