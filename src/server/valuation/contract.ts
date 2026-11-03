/**
 * The values the publish step may read (brief #207, the contract between Issue B and Issue C).
 * Issue B implements `readCollectionValues` in `src/server/valuation/values.ts`; the projection
 * (Issue C) is its only caller under `src/server/publish/`, and decides from the settings what of
 * it, if anything, is published ([PUB-17], [PUB-18]). Everything here is private until shown.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/** One item's value ([VAL-5]): the amount for its whole quantity, in `currency`. */
export interface ItemValue {
  readonly amount: number;
  readonly currency: string;
  readonly source: 'bricklink' | 'override';
  /** The quote's fetched-at time for a BrickLink value, ISO 8601; null for an override. */
  readonly asOf: string | null;
}

/**
 * The loose parts' value ([VAL-6], #229): the sum of every lot's value that has one, in the
 * deployment's currency, and how many lots were valued from BrickLink, from the file, and not at all.
 */
export interface PartsValue {
  /** The sum over the lots with a value, to the cent; null when no lot has one. */
  readonly amount: number | null;
  /** Always the deployment's currency: a lot is valued only in it. */
  readonly currency: string;
  readonly fromBrickLink: number;
  readonly fromFile: number;
  readonly none: number;
}

export interface CollectionValues {
  /** Every item's value by its id, or null when it has none. */
  readonly items: ReadonlyMap<string, ItemValue | null>;
  /** The loose parts' value by `[VAL-6]`, or null when no parts are imported. */
  readonly parts: PartsValue | null;
  /**
   * Every imported lot's value by `[VAL-6]`, by the lot's id, to the cent; null for a lot with
   * none. The parts download's per-lot unit price is a lot's value divided by its quantity ([PUB-20]).
   */
  readonly partsLots: ReadonlyMap<string, number | null>;
  /** The deployment's currency (`PLINTHOS_CURRENCY`). */
  readonly currency: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ValuesDatabase = PgDatabase<PgQueryResultHKT, any>;

/** Implemented by Issue B. Reads only the values: never a storage location or an asking price. */
export declare function readCollectionValues(db: ValuesDatabase): Promise<CollectionValues>;
