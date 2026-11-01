import { randomBytes } from 'node:crypto';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { readDatabaseUrl } from '../../src/db/database-url';
import * as schema from '../../src/db/schema';
import { connectTestDatabase } from './database';

/**
 * An empty database of its own on the test server, so test files that migrate never share one,
 * and Drizzle's TCP driver over it: only tests use that driver ([PLAT-9]). `drop` removes it.
 */
export interface FreshDatabase {
  readonly db: NodePgDatabase<typeof schema>;
  readonly client: pg.Client;
  /** Applies every migration in `drizzle/` with the TCP driver's migrator. */
  readonly migrate: typeof migrate;
  drop(): Promise<void>;
}

export async function freshDatabase(): Promise<FreshDatabase> {
  const name = `plinthos_test_${randomBytes(6).toString('hex')}`;
  const admin = await connectTestDatabase();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(readDatabaseUrl());
  url.pathname = `/${name}`;
  const client = await connectTestDatabase(url.toString());
  return {
    db: drizzle(client, { schema }),
    client,
    migrate,
    async drop() {
      await client.end();
      const again = await connectTestDatabase();
      try {
        await again.query(`drop database if exists ${name} with (force)`);
      } finally {
        await again.end();
      }
    },
  };
}
