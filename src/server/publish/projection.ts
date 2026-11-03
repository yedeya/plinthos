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
 * snapshot is `publishedAt`, the publish's own clock.
 *
 * **Values and selling mode (#211).** It reads `show_values`, `selling_mode` and
 * `selling_value_display`, and publishes exactly what they show (`shownBy`, [PUB-17], [PUB-18]),
 * never the switches themselves:
 * - **market values** while Show values is on with selling mode off, or with selling mode on and
 *   the display `MARKET` or `BOTH`: each item's value with the day it is estimated as of, the
 *   loose parts' value, the totals, each the sum of the values published, and in selling mode each
 *   lot's unit price in the parts download. `readCollectionValues` (`../valuation/values.ts`) is
 *   called only when the settings show something; its items and parts are used only when they
 *   show market values, and only an amount in the deployment's currency is published.
 * - **asking prices** only with selling mode on and the display `ASKING` or `BOTH`: they are
 *   selected from the settings only then, so an asking price stored while selling mode is off is
 *   never even read.
 * - **in selling mode** the split views (`segments`, [PUB-19]) and the lots for the parts download
 *   (`readDownloadLots`, `../parts/lots.ts`, [PUB-20]), their unit prices read only with market values.
 * A hidden field is absent from the data, never `null` (`./catalogue-data.ts`).
 * An item's value never names its source: a BrickLink value is dated by its quote's day, the
 * owner's own estimate by the publish's day. A visitor can still infer which values are dated the
 * publish's day, and so roughly which are overrides (`docs/security-review.md`, F-14, accepted).
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
import { catalogueSettings, SELLING_VALUE_DISPLAYS } from '../../db/schema/catalogue-settings';
import { collectionItem, CONDITIONS, KINDS } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { photo } from '../../db/schema/photo';
import { readDownloadLots } from '../parts/lots';
import { readPartsSummary } from '../parts/summary';
import { STORED_KEY } from '../photos/keys';
import type { CollectionValues, ItemValue } from '../valuation/contract';
import { readCollectionValues, segmentOf } from '../valuation/values';
import type { PublicAsking, PublicCatalogueData, PublicItem, PublicLot, PublicParts, PublicPhoto, PublicSegment, PublicTotals } from './catalogue-data';
import { asCatalogueToken, generateCatalogueToken, type CatalogueToken } from './token';

/** Either driver's database: the Data API's in deployed code, the TCP one in tests ([PLAT-9]). */
export type PublishDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The snapshot's format, which `catalogue.json` leads with, so a later reader can tell it apart. */
export const SNAPSHOT_FORMAT = 4 satisfies PublicCatalogueData['format'];

/** Reads the collection's values: `readCollectionValues` when deployed; tests give their own. */
export type ValuesReader = (db: PublishDatabase) => Promise<CollectionValues>;

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
    /** Where the values come from, read in this turn and only when the settings show any ([PUB-17]). */
    readonly readValues?: ValuesReader;
  },
): Promise<Publication> {
  const lease = await takeTurn(db, options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  const release = () => endTurn(db, lease);
  try {
    const token = await claimToken(db, options.ifPublished === true);
    const projection = await project(db, options.now(), options.readValues ?? readCollectionValues);
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
async function project(db: PublishDatabase, now: Date, readValues: ValuesReader): Promise<PublicProjection> {
  const [settings] = await db
    .select({
      introText: catalogueSettings.introText,
      contactText: catalogueSettings.contactText,
      // Read to decide what is shown, never published (#19, #211).
      showValues: catalogueSettings.showValues,
      sellingMode: catalogueSettings.sellingMode,
      sellingValueDisplay: catalogueSettings.sellingValueDisplay,
    })
    .from(catalogueSettings);
  if (settings === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  const shown = shownBy(settings);
  const today = now.toISOString().slice(0, 10);
  // The values only when something is shown; their items and parts only with market values.
  const read = shown.market || shown.asking ? await readValues(db) : null;
  if (read !== null && !CURRENCY.test(read.currency)) throw new Error('The deployment’s currency is not a three-letter ISO 4217 code.');
  const values = shown.market ? read : null;

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
        ...(values === null ? {} : publicValue(values.items.get(item.id), values.currency, today)),
        ...(shown.selling ? { segment: segmentOf({ kind: item.kind, condition }) } : {}),
      } satisfies PublicItem);
    });

  const parts = await readPublicParts(db, copy, { selling: shown.selling, values });
  const totals = values === null ? undefined : totalsOf(published, parts?.value);
  const segmentsHeld = new Set<PublicSegment>(published.map((item) => segmentOf(item)));
  const asking = shown.asking ? await readAsking(db) : undefined;
  const priced = totals !== undefined || asking !== undefined || (parts?.list ?? []).some((lot) => lot.price !== undefined);
  // [PUB-19] The split views with anything in them: the parts view holds the loose parts and the bulk lots.
  const segments: PublicSegment[] = [
    ...(segmentsHeld.has('sealed') ? (['sealed'] as const) : []),
    ...(segmentsHeld.has('used') ? (['used'] as const) : []),
    ...(parts !== null || segmentsHeld.has('parts') ? (['parts'] as const) : []),
  ];

  const catalogue: PublicCatalogueData = Object.freeze({
    format: SNAPSHOT_FORMAT,
    publishedAt: now.toISOString(),
    introText: settings.introText,
    contactText: settings.contactText,
    items: Object.freeze(published),
    parts,
    // Each only when the settings show it: absent, never null ([PUB-17], [PUB-18]).
    ...(priced && read !== null ? { valueCurrency: read.currency } : {}),
    ...(totals === undefined ? {} : { totals }),
    ...(asking === undefined ? {} : { asking }),
    ...(shown.selling ? { segments: Object.freeze(segments) } : {}),
  });
  return Object.freeze({ catalogue, photoCopies: Object.freeze(photoCopies) }) as PublicProjection;
}

/** A currency code as ISO 4217 writes it: the only form a page formats an amount in. */
const CURRENCY = /^[A-Z]{3}$/;

/** What the settings show ([PUB-17], [PUB-18]). */
interface Shown {
  /** Market values: the items', the parts', their totals and the lots' unit prices. */
  readonly market: boolean;
  /** The owner's asking prices. */
  readonly asking: boolean;
  /** Selling mode: the split views and the parts download. */
  readonly selling: boolean;
}

/**
 * With selling mode off, Show values alone decides, and no asking price is ever shown. With it
 * on, the display alone decides and Show values is ignored; a display not set yet is `ASKING`,
 * the default selling mode starts with (`HANDOVER.md` §10.9).
 */
function shownBy(settings: { readonly showValues: boolean; readonly sellingMode: boolean; readonly sellingValueDisplay: string | null }): Shown {
  if (!settings.sellingMode) return { market: settings.showValues, asking: false, selling: false };
  const display = SELLING_VALUE_DISPLAYS.find((known) => known === settings.sellingValueDisplay) ?? 'ASKING';
  return { market: display !== 'ASKING', asking: display !== 'MARKET', selling: true };
}

/** An amount as published: finite, not negative, to the cent; anything else is none. */
function cents(amount: number | null | undefined): number | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return undefined;
  return Math.round(amount * 100) / 100;
}

/** A day, `YYYY-MM-DD`, from an ISO 8601 instant; none when it is not one. Never the time of day. */
function dayOf(iso: string | null): string | undefined {
  if (iso === null) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

/**
 * An item's value as published: its amount in the deployment's currency, and the day it is
 * estimated as of. A BrickLink value is dated by its quote; the owner's own estimate by the day of
 * this publish: the catalogue never labels a value overridden, though its date lets a visitor infer
 * it (F-14, accepted). Nothing for an item with no value, or one in another currency, which no
 * total could add up.
 */
function publicValue(value: ItemValue | null | undefined, currency: string, today: string): { value: number; asOf: string } | Record<string, never> {
  if (value === null || value === undefined || value.currency !== currency) return {};
  const amount = cents(value.amount);
  if (amount === undefined) return {};
  return { value: amount, asOf: (value.source === 'bricklink' ? dayOf(value.asOf) : undefined) ?? today };
}

/**
 * The totals of the values published ([PUB-17]), per segment by `segmentOf` ([VAL-7]): never of a
 * value the snapshot doesn't hold, so no total says more than the items do. Every value published
 * is in the deployment's currency, so no total adds two. None when nothing has a value.
 */
function totalsOf(items: readonly PublicItem[], partsValue: number | undefined): PublicTotals | undefined {
  const sum = (amounts: readonly (number | undefined)[]) => {
    const held = amounts.filter((amount): amount is number => amount !== undefined);
    return held.length === 0 ? undefined : cents(held.reduce((total, amount) => total + amount, 0));
  };
  const of = (segment: PublicSegment) => items.filter((item) => segmentOf(item) === segment).map((item) => item.value);
  const sealed = sum(of('sealed'));
  const used = sum(of('used'));
  const parts = sum([partsValue, ...of('parts')]);
  const all = sum([sealed, used, parts]);
  if (all === undefined) return undefined;
  return Object.freeze({
    all,
    ...(sealed === undefined ? {} : { sealed }),
    ...(used === undefined ? {} : { used }),
    ...(parts === undefined ? {} : { parts }),
  });
}

/**
 * The owner's asking prices ([PUB-18]), selected only when the settings show them: overall and per
 * segment, each only when entered. None when none is.
 */
async function readAsking(db: PublishDatabase): Promise<PublicAsking | undefined> {
  const [row] = await db
    .select({
      total: catalogueSettings.askingPriceTotal,
      sealed: catalogueSettings.askingPriceSealed,
      used: catalogueSettings.askingPriceUsed,
      parts: catalogueSettings.askingPriceParts,
    })
    .from(catalogueSettings);
  if (row === undefined) return undefined;
  const entries = (['total', 'sealed', 'used', 'parts'] as const).flatMap((key) => {
    const amount = cents(row[key]);
    return amount === undefined ? [] : [[key, amount] as const];
  });
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}

/**
 * The loose parts' summary ([PUB-14]): how many lots and loose parts the last import holds, and
 * the parts lot's overview photos, each copied as an item's are ([PUB-13]). `readPartsSummary`
 * (`src/server/parts/summary.ts`, #161) reads no unit price, no value, no currency and nothing of
 * a lot, and this keeps only its two counts and copies of its photos. With market values shown it
 * adds the parts' value; in selling mode, the lots for the download ([PUB-20]), each with its
 * unit price only with market values, and only when the file's prices are in the deployment's
 * currency (a file that names none is taken to be).
 */
async function readPublicParts(
  db: PublishDatabase,
  copy: (from: string) => string,
  { selling, values }: { readonly selling: boolean; readonly values: CollectionValues | null },
): Promise<PublicParts | null> {
  const summary = await readPartsSummary(db);
  if (summary === null) return null;
  const value = values?.parts !== null && values?.parts !== undefined && values.parts.currency === values.currency ? cents(values.parts.amount) : undefined;
  const download = selling ? await readDownloadLots(db, { prices: values !== null }) : null;
  const priced = values !== null && download !== null && (download.currency ?? values.currency) === values.currency;
  const list = download?.lots.map((lot): PublicLot => {
    const price = priced && typeof lot.unitPrice === 'number' && Number.isFinite(lot.unitPrice) && lot.unitPrice > 0 ? Math.round(lot.unitPrice * 1000) / 1000 : undefined;
    return Object.freeze({
      type: lot.itemType,
      no: lot.itemNo,
      color: lot.colorId,
      condition: lot.condition,
      quantity: lot.quantity,
      ...(price === undefined ? {} : { price }),
    });
  });
  return Object.freeze({
    lots: summary.lots,
    quantity: summary.quantity,
    photos: Object.freeze(summary.photos.map((row): PublicPhoto => Object.freeze({ full: copy(row.fullKey), thumb: copy(row.thumbnailKey) }))),
    ...(value === undefined ? {} : { value }),
    ...(list === undefined || list.length === 0 ? {} : { list: Object.freeze(list) }),
  });
}
