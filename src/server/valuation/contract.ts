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

export interface CollectionValues {
  /** Every item's value by its id, or null when it has none. */
  readonly items: ReadonlyMap<string, ItemValue | null>;
  /** The loose parts' value from the imported file ([VAL-6]), or null when the file had no prices. */
  readonly parts: { readonly amount: number; readonly currency: string } | null;
  /** The deployment's currency (`PLINTHOS_CURRENCY`). */
  readonly currency: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ValuesDatabase = PgDatabase<PgQueryResultHKT, any>;

/** Implemented by Issue B. Reads only the values: never a storage location or an asking price. */
export declare function readCollectionValues(db: ValuesDatabase): Promise<CollectionValues>;
