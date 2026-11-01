/**
 * The connection string of the PostgreSQL server reached over TCP.
 *
 * Only tests reach the database this way, against the server the project-setup hook starts;
 * deployed code goes through the RDS Data API instead ([PLAT-9]). An unset or empty
 * `DATABASE_URL` throws rather than returning a default, so a test that needs the database
 * fails instead of passing or skipping without one ([DEV-3]).
 */
export function readDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is unset: this test needs the PostgreSQL server the project-setup hook starts (docs/qa/test-database.md).',
    );
  }
  return url;
}
