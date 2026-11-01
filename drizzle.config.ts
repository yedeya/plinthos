import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit's configuration: the schema in `src/db/schema/`, and the migrations it generates in
 * `drizzle/` (`npm run db:generate`, [PLAT-11]). Generating reaches no database.
 *
 * `scripts/schema-check.ts` points `DRIZZLE_SCHEMA` and `DRIZZLE_OUT` elsewhere to check, in a
 * copy, that the committed migrations already hold every schema change. Nothing else sets them.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: process.env.DRIZZLE_SCHEMA ?? './src/db/schema/index.ts',
  out: process.env.DRIZZLE_OUT ?? './drizzle',
});
