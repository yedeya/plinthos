/**
 * The public projection: the one function through which the publish step reads the database,
 * and the only place that decides what leaves the private side ([PUB-5], `AGENTS.md` §1). Its
 * changes go to the Owner (`docs/qa/escalation-paths.md`).
 *
 * `readPublication` returns the catalogue token, made on the first publish, and the projection.
 * The projection is a value only this module can make: the snapshot writer refuses anything else
 * (`./snapshot.ts`), at compile time through its type and at run time through `assertPublicProjection`.
 * So a private field can reach a snapshot only by being added here, where the Owner reviews it.
 *
 * In the walking skeleton the catalogue has no content (brief #6, §2): the projection says only
 * that nothing is published yet. It reads none of the settings, because nothing in it is a value a
 * setting could show or hide. `show_values`, `selling_mode` and `selling_value_display` stay
 * private (#19, `src/db/schema/classification.ts`): the snapshot will show their effect, which
 * values appear, never the switches themselves, and the content item that first publishes a value
 * reads them here. `[PUB-4]`'s test publishes under every combination of them all the same.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { DrizzleQueryError, isNull } from 'drizzle-orm';
import type * as schema from '../../db/schema';
import { catalogueSettings } from '../../db/schema/catalogue-settings';
import { asCatalogueToken, generateCatalogueToken, type CatalogueToken } from './token';

/** Either driver's database: the Data API's in deployed code, the TCP one in tests ([PLAT-9]). */
export type PublishDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The snapshot's format, which `catalogue.json` leads with, so a later reader can tell it apart. */
export const SNAPSHOT_FORMAT = 1;

/** Everything a snapshot holds: only public data, every field of it named here. */
export interface PublicCatalogue {
  readonly format: typeof SNAPSHOT_FORMAT;
  /** The skeleton's placeholder: no set, no part and no value is published yet. */
  readonly status: 'placeholder';
  /** When this snapshot was made, as an ISO 8601 instant. */
  readonly publishedAt: string;
}

declare const brand: unique symbol;

/** The projection, which only `readPublication` makes ([PUB-5]). */
export interface PublicProjection {
  readonly catalogue: PublicCatalogue;
  readonly [brand]: true;
}

export class NotAPublicProjectionError extends Error {
  override name = 'NotAPublicProjectionError';
}

const issued = new WeakSet<object>();

/** Refuses any value `readPublication` did not make, however right its shape ([PUB-5]). */
export function assertPublicProjection(value: unknown): asserts value is PublicProjection {
  if (typeof value !== 'object' || value === null || !issued.has(value)) {
    throw new NotAPublicProjectionError('The snapshot writer takes only the public projection that readPublication makes.');
  }
}

export interface Publication {
  readonly token: CatalogueToken;
  readonly projection: PublicProjection;
}

/**
 * Reads what one publish needs: the token, made and stored on the first publish, and the public
 * projection. The token is claimed with a conditional update, so two publishes at once agree on one
 * token. Nothing else is read.
 */
export async function readPublication(db: PublishDatabase, options: { readonly now: Date }): Promise<Publication> {
  const token = await claimToken(db);
  const catalogue: PublicCatalogue = Object.freeze({
    format: SNAPSHOT_FORMAT,
    status: 'placeholder',
    publishedAt: options.now.toISOString(),
  });
  const projection = Object.freeze({ catalogue }) as PublicProjection;
  issued.add(projection);
  return { token, projection };
}

/** Storing a new token failed. It carries the driver's error, never the query or its parameters. */
export class TokenClaimError extends Error {
  override name = 'TokenClaimError';
  constructor(cause: unknown) {
    super('Storing the new catalogue token failed.', { cause });
  }
}

async function claimToken(db: PublishDatabase): Promise<CatalogueToken> {
  const select = () => db.select({ publicToken: catalogueSettings.publicToken }).from(catalogueSettings);
  const [settings] = await select();
  if (settings === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  if (settings.publicToken !== null) return asCatalogueToken(settings.publicToken);
  try {
    await db.update(catalogueSettings).set({ publicToken: generateCatalogueToken() }).where(isNull(catalogueSettings.publicToken));
  } catch (error) {
    // Drizzle's error message holds the query's parameters, and so the new token (#65): keep only
    // the driver's own error, which names the database's reason and no parameter.
    throw new TokenClaimError(error instanceof DrizzleQueryError ? error.cause : undefined);
  }
  // Read back, so a publish that lost the race to another one uses the winner's token.
  const [claimed] = await select();
  return asCatalogueToken(claimed?.publicToken);
}
