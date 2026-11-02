/**
 * The public projection: the one function through which the publish step reads the database,
 * and the only place that decides what leaves the private side ([PUB-5], `AGENTS.md` §1). Its
 * changes go to the Owner (`docs/qa/escalation-paths.md`).
 *
 * `readPublication` takes the publish's turn, then returns the catalogue token, made on the first
 * publish, and the projection, with the function that ends the turn ([PUB-8]).
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
import { randomUUID } from 'node:crypto';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { DrizzleQueryError, eq, isNull, lte, or, sql } from 'drizzle-orm';
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
  /** Ends this publish's turn, so the next publish need not wait for it to run out. */
  release(): Promise<void>;
}

/**
 * How long a publish's turn lasts if it never ends it. Every publish runs in the admin's server
 * function, which Lambda stops after `SERVER_TIMEOUT` (`infra/admin.ts`), so a turn this long never
 * runs out while its publish could still be writing (`tests/infra/snapshot.test.ts`).
 */
export const PUBLISH_LEASE_SECONDS = 180;

/** How often a publish asks again for the turn another one holds, and how long apart. */
export const LEASE_WAIT = { attempts: 8, ms: 1000 } as const;

/** Another publish held the turn for as long as this one waited: nothing was read or written. */
export class PublishInProgressError extends Error {
  override name = 'PublishInProgressError';
  constructor() {
    super('Another publish is still running.');
  }
}

/**
 * Reads what one publish needs, in its turn: publishes take turns, so the snapshot in the bucket
 * is always one publish's files whole, and a failed publish's restore puts back the files of the
 * publish before it, never those of one running beside it ([PUB-8]). It waits for a turn another
 * publish holds, a few seconds at most, and the caller ends its own with `release`.
 *
 * Then it reads the token, made and stored on the first publish, and builds the public projection.
 * The token is claimed with a conditional update all the same. Nothing else is read.
 */
export async function readPublication(
  db: PublishDatabase,
  options: { readonly now: () => Date; readonly sleep?: (ms: number) => Promise<void> },
): Promise<Publication> {
  const lease = await takeTurn(db, options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  const release = () => endTurn(db, lease);
  try {
    const token = await claimToken(db);
    const catalogue: PublicCatalogue = Object.freeze({
      format: SNAPSHOT_FORMAT,
      status: 'placeholder',
      publishedAt: options.now().toISOString(),
    });
    const projection = Object.freeze({ catalogue }) as PublicProjection;
    issued.add(projection);
    return { token, projection, release };
  } catch (error) {
    // The turn ends with this publish, or runs out on its own if ending it fails too.
    await release().catch(() => undefined);
    throw error;
  }
}

/**
 * Takes the turn when no publish holds it or the one that did has run out, asking again while
 * another holds it. Each attempt is one statement through the Data API, which holds no connection
 * open between them, so a turn never keeps Aurora awake past its publish (`AGENTS.md` §3).
 */
async function takeTurn(db: PublishDatabase, sleep: (ms: number) => Promise<void>): Promise<string> {
  const lease = randomUUID();
  for (let attempt = 1; ; attempt += 1) {
    const taken = await db
      .update(catalogueSettings)
      .set({ publishLease: lease, publishLeaseUntil: sql`now() + ${sql.raw(`interval '${PUBLISH_LEASE_SECONDS} seconds'`)}` })
      .where(or(isNull(catalogueSettings.publishLeaseUntil), lte(catalogueSettings.publishLeaseUntil, sql`now()`)))
      .returning({ id: catalogueSettings.id });
    if (taken.length > 0) return lease;
    const [settings] = await db.select({ id: catalogueSettings.id }).from(catalogueSettings);
    if (settings === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
    if (attempt >= LEASE_WAIT.attempts) throw new PublishInProgressError();
    await sleep(LEASE_WAIT.ms);
  }
}

/** Ends the turn, if it is still this publish's. */
async function endTurn(db: PublishDatabase, lease: string): Promise<void> {
  await db
    .update(catalogueSettings)
    .set({ publishLease: null, publishLeaseUntil: null })
    .where(eq(catalogueSettings.publishLease, lease));
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
