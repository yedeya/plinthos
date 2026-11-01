/**
 * The database schema: every table, which `drizzle.config.ts` generates the migrations in
 * `drizzle/` from ([PLAT-11]). Every column of every table here is classified public or private
 * in `./classification.ts` ([PUB-3]).
 */
export { adminSession } from './admin-session';
export { catalogueSettings } from './catalogue-settings';
