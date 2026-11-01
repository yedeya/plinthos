import { sql, type SQL } from 'drizzle-orm';

/**
 * Applies every pending migration in `drizzle/` and says how many it applied ([PLAT-12]).
 *
 * The deploy runs it through the Data API after `sst deploy` and before the smoke check
 * (`scripts/migrate.ts`, docs/deploy.md); the tests run the same function over the TCP driver.
 * Drizzle records each applied migration in `drizzle.__drizzle_migrations` and applies only the
 * newer ones, all in one transaction, so a second run applies none and a failed run applies none.
 * That bookkeeping table is Drizzle's, in its own schema, and holds no application data.
 */

export const MIGRATIONS_FOLDER = 'drizzle';

/** The one method of a Drizzle database this needs, whichever driver it uses. */
export interface ExecutesSql {
  execute(query: SQL): PromiseLike<{ rows: unknown[] }>;
}

export interface MigrationResult {
  /** Migrations this run applied. */
  readonly applied: number;
  /** Migrations the database holds after it, including those applied before. */
  readonly total: number;
}

/** How many migrations the database records as applied. */
export async function appliedMigrations(db: ExecutesSql): Promise<number> {
  // Two statements: one that names a missing table fails to plan, whichever branch would run.
  const exists = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if ((exists.rows[0] as { present?: unknown } | undefined)?.present !== true) return 0;
  const { rows } = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

export async function applyMigrations<D extends ExecutesSql>(
  db: D,
  migrate: (db: D, config: { migrationsFolder: string }) => Promise<void>,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<MigrationResult> {
  const before = await appliedMigrations(db);
  await migrate(db, { migrationsFolder });
  const total = await appliedMigrations(db);
  return { applied: total - before, total };
}
