/**
 * The public projection: the one function through which the publish step reads the database,
 * and the only place that decides what leaves the private side ([PUB-5], `AGENTS.md` §1). Its
 * changes go to the Owner (`docs/qa/escalation-paths.md`).
 *
 * `readPublication` takes the publish's turn, then returns the catalogue token, made on the first
 * publish, and the projection, with the function that ends the turn ([PUB-8]) and the one that
 * replaces the token, for a rotation ([PUB-15]).
 * The projection is a value only this module can make: the snapshot writer refuses anything else
 * (`./snapshot.ts`), at compile time through its type and at run time through `assertPublicProjection`.
 * So a private field can reach a snapshot only by being added here, where the Owner reviews it.
 *
 * What it reads (#162, brief #154): every item with its set, when it is one (#202), each item's photos in order with its
 * cover first, the catalogue's two texts and the parts summary with the parts lot's overview
 * photos (#174), through `readPartsSummary` (`src/server/parts/summary.ts`), in the same turn. What it publishes is
 * `PublicCatalogueData` (`./catalogue-data.ts`), every field public in `[PUB-3]`'s registry. It
 * never reads a storage location, a value, a setting switch or a timestamp: the only instant in a
 * snapshot is `publishedAt`, the publish's own clock. `show_values`, `selling_mode` and
 * `selling_value_display` stay private and unread until the valuation milestone (#19, brief #154
 * decision 2); `[PUB-4]`'s test publishes under every combination of them all the same.
 *
 * A published photo is a copy (`[PUB-13]`): the projection gives each stored size a new random
 * public path, `p/{random}.webp`, which is all the catalogue names, and hands the writer the pairs
 * to copy, private key to public path. The private keys are in those pairs only, never in
 * `catalogue`, and the writer writes them into no file.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { asc, DrizzleQueryError, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type * as schema from '../../db/schema';
import { catalogueSettings } from '../../db/schema/catalogue-settings';
import { collectionItem, CONDITIONS, KINDS } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { photo } from '../../db/schema/photo';
import { readPartsSummary } from '../parts/summary';
import { STORED_KEY } from '../photos/keys';
import type { PublicCatalogueData, PublicItem, PublicParts, PublicPhoto } from './catalogue-data';
import { asCatalogueToken, generateCatalogueToken, type CatalogueToken } from './token';

/** Either driver's database: the Data API's in deployed code, the TCP one in tests ([PLAT-9]). */
export type PublishDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The snapshot's format, which `catalogue.json` leads with, so a later reader can tell it apart. */
export const SNAPSHOT_FORMAT = 3 satisfies PublicCatalogueData['format'];

/** A public photo's path inside the snapshot: `p/`, 256 random bits in base64url, `.webp`. */
export const PUBLIC_PHOTO_PATH = /^p\/[A-Za-z0-9_-]{43}\.webp$/;

/** One stored size to copy into the snapshot: from its private key to its new public path. */
export interface PhotoCopy {
  /** The private stored size, `photos/{random}.webp`: read by the copy, written into no file. */
  readonly from: string;
  /** Its public path inside the snapshot's folder, `p/{random}.webp`, which the catalogue names. */
  readonly to: string;
}

declare const brand: unique symbol;

/** The projection, which only `readPublication` makes ([PUB-5]). */
export interface PublicProjection {
  readonly catalogue: PublicCatalogueData;
  /** Every published photo's stored sizes and their public paths ([PUB-13]). */
  readonly photoCopies: readonly PhotoCopy[];
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
  /**
   * Stores `next` in place of `token`, for a rotation, once the snapshot under `next` is written
   * ([PUB-15]). It refuses when the stored token is no longer `token`.
   */
  replaceToken(next: CatalogueToken): Promise<void>;
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
 * The token is claimed with a conditional update all the same.
 */
export async function readPublication(
  db: PublishDatabase,
  options: {
    readonly now: () => Date;
    readonly sleep?: (ms: number) => Promise<void>;
    /**
     * For a republish after a delete (#187): publish only a catalogue that is already published.
     * With no stored token it makes none and throws `NotPublishedError`, having read nothing else.
     */
    readonly ifPublished?: boolean;
  },
): Promise<Publication> {
  const lease = await takeTurn(db, options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  const release = () => endTurn(db, lease);
  try {
    const token = await claimToken(db, options.ifPublished === true);
    const projection = await project(db, options.now());
    issued.add(projection);
    return { token, projection, release, replaceToken: (next) => replaceToken(db, token, next) };
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

/** A republish found no catalogue published yet, so it made no token and read nothing else (#187). */
export class NotPublishedError extends Error {
  override name = 'NotPublishedError';
  constructor() {
    super('The catalogue has not been published yet.');
  }
}

/** Storing a new token failed. It carries the driver's error, never the query or its parameters. */
export class TokenClaimError extends Error {
  override name = 'TokenClaimError';
  constructor(cause: unknown) {
    super('Storing the new catalogue token failed.', { cause });
  }
}

async function claimToken(db: PublishDatabase, ifPublished: boolean): Promise<CatalogueToken> {
  const select = () => db.select({ publicToken: catalogueSettings.publicToken }).from(catalogueSettings);
  const [settings] = await select();
  if (settings === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  if (settings.publicToken !== null) return asCatalogueToken(settings.publicToken);
  if (ifPublished) throw new NotPublishedError();
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

/** Stores the rotation's new token, only while the stored one is still the token this publish used. */
async function replaceToken(db: PublishDatabase, current: CatalogueToken, next: CatalogueToken): Promise<void> {
  const token = asCatalogueToken(next);
  let replaced: { id: string }[];
  try {
    replaced = await db
      .update(catalogueSettings)
      .set({ publicToken: token })
      .where(eq(catalogueSettings.publicToken, current))
      .returning({ id: catalogueSettings.id });
  } catch (error) {
    // As in claimToken: Drizzle's message carries both tokens among its parameters (#65).
    throw new TokenClaimError(error instanceof DrizzleQueryError ? error.cause : undefined);
  }
  if (replaced.length === 0) throw new TokenClaimError(new Error('The stored catalogue token changed during the rotation.'));
}

/** A public path for one copy of a stored size: 256 random bits, nothing derived from the key. */
function publicPhotoPath(): string {
  return `p/${randomBytes(32).toString('base64url')}.webp`;
}

/** The catalogue's stock image, only as an absolute `https://` address; anything else is left out. */
function stockImage(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

const bySetNumber = new Intl.Collator('en', { numeric: true });

/**
 * Builds the projection: the only reads of catalogue content in the publish step. Each query
 * names its columns, so a column added to a table later reaches no snapshot until it is named
 * here.
 */
async function project(db: PublishDatabase, now: Date): Promise<PublicProjection> {
  const [settings] = await db
    .select({ introText: catalogueSettings.introText, contactText: catalogueSettings.contactText })
    .from(catalogueSettings);
  if (settings === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');

  const items = await db
    .select({
      id: collectionItem.id,
      kind: collectionItem.kind,
      setNum: collectionItem.setNum,
      ownName: collectionItem.name,
      refNo: collectionItem.refNo,
      approxParts: collectionItem.approxParts,
      approxWeightG: collectionItem.approxWeightG,
      condition: collectionItem.condition,
      complete: collectionItem.complete,
      missingNotes: collectionItem.missingNotes,
      hasInstructions: collectionItem.hasInstructions,
      description: collectionItem.description,
      quantity: collectionItem.quantity,
      // Read to put the cover first, never published.
      coverPhotoId: collectionItem.coverPhotoId,
      setName: legoSet.name,
      theme: legoSet.theme,
      year: legoSet.year,
      numParts: legoSet.numParts,
      imageUrl: legoSet.imageUrl,
    })
    .from(collectionItem)
    // A non-set has no catalogue row (#202).
    .leftJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum));

  // The admin's own order (`src/server/items/covers.ts`): by position, then by when each was
  // added. The ordering reads both in the query; neither is selected, so neither is published.
  const photos = await db
    .select({ id: photo.id, itemId: photo.itemId, fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey })
    .from(photo)
    .where(isNotNull(photo.itemId))
    .orderBy(sql`${photo.position} asc nulls last`, asc(photo.createdAt), asc(photo.id));

  const photoCopies: PhotoCopy[] = [];
  /** A stored size's public copy, refusing a key that is not one the server made ([PHOTO-6]). */
  const copy = (from: string): string => {
    if (!STORED_KEY.test(from)) throw new Error('A photo’s stored key is not one the server makes: refusing to publish it.');
    const to = publicPhotoPath();
    photoCopies.push({ from, to });
    return to;
  };

  const photosOf = new Map<string, (typeof photos)[number][]>();
  for (const row of photos) {
    if (row.itemId === null) continue;
    photosOf.set(row.itemId, [...(photosOf.get(row.itemId) ?? []), row]);
  }

  const published: PublicItem[] = items
    .map((item) => {
      const kind = KINDS.find((known) => known === item.kind);
      if (kind === undefined) throw new Error('An item has a kind the catalogue does not know.');
      // A set's facts are its catalogue row's; every other kind has none and names itself (#202).
      const isSet = kind === 'SET';
      const name = isSet ? item.setName : item.ownName;
      if (name === null || (isSet && item.setNum === null)) throw new Error('An item has no name the catalogue can show.');
      return { ...item, kind, isSet, name };
    })
    .sort(
      (a, b) =>
        Number(!a.isSet) - Number(!b.isSet) ||
        (a.isSet ? bySetNumber.compare(a.setNum ?? '', b.setNum ?? '') : bySetNumber.compare(a.name, b.name)) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((item) => {
      const own = photosOf.get(item.id) ?? [];
      const ordered = [...own.filter(({ id }) => id === item.coverPhotoId), ...own.filter(({ id }) => id !== item.coverPhotoId)];
      const condition = CONDITIONS.find((known) => known === item.condition);
      if (condition === undefined) throw new Error('An item has a condition the catalogue does not know.');
      const isBulk = item.kind === 'BULK';
      return Object.freeze({
        id: item.id,
        kind: item.kind,
        setNum: item.isSet ? item.setNum : null,
        name: item.name,
        refNo: item.refNo?.trim() || null,
        theme: item.isSet ? item.theme : null,
        year: item.isSet ? item.year : null,
        numParts: item.isSet ? item.numParts : null,
        approxParts: isBulk ? item.approxParts : null,
        approxWeightG: isBulk ? item.approxWeightG : null,
        condition,
        complete: item.complete,
        missingNotes: item.complete === false ? item.missingNotes?.trim() || null : null,
        hasInstructions: item.hasInstructions,
        description: item.description,
        quantity: item.quantity,
        stockImageUrl: item.isSet ? stockImage(item.imageUrl) : null,
        photos: Object.freeze(ordered.map((row): PublicPhoto => Object.freeze({ full: copy(row.fullKey), thumb: copy(row.thumbnailKey) }))),
      } satisfies PublicItem);
    });

  const catalogue: PublicCatalogueData = Object.freeze({
    format: SNAPSHOT_FORMAT,
    publishedAt: now.toISOString(),
    introText: settings.introText,
    contactText: settings.contactText,
    items: Object.freeze(published),
    parts: await readPublicParts(db, copy),
  });
  return Object.freeze({ catalogue, photoCopies: Object.freeze(photoCopies) }) as PublicProjection;
}

/**
 * The loose parts' summary ([PUB-14]): how many lots and loose parts the last import holds, and
 * the parts lot's overview photos, each copied as an item's are ([PUB-13]). `readPartsSummary`
 * (`src/server/parts/summary.ts`, #161) reads no unit price, no value, no currency and nothing of
 * a lot, and this keeps only its two counts and copies of its photos: no lot list is published.
 */
async function readPublicParts(db: PublishDatabase, copy: (from: string) => string): Promise<PublicParts | null> {
  const summary = await readPartsSummary(db);
  if (summary === null) return null;
  return Object.freeze({
    lots: summary.lots,
    quantity: summary.quantity,
    photos: Object.freeze(summary.photos.map((row): PublicPhoto => Object.freeze({ full: copy(row.fullKey), thumb: copy(row.thumbnailKey) }))),
  });
}
