/**
 * STAND-IN for Issue B (#210, PR #214), which replaces this file at merge with the real
 * `readCollectionValues` (`./contract.ts`) and `segmentOf`. Until then `readCollectionValues`
 * answers that nothing has a value: an empty map, no parts value, and the reference deployment's
 * currency. `segmentOf` is #210's rule, with its signature. The publish step's tests inject their
 * own values through `readPublication`'s `readValues` (#211).
 */
import type { Condition, Kind } from '../../db/schema/collection-item';
import type { CollectionValues, ValuesDatabase } from './contract';

/** STAND-IN: no item has a value yet. */
export async function readCollectionValues(db: ValuesDatabase): Promise<CollectionValues> {
  void db;
  return { items: new Map(), parts: null, currency: 'EUR' };
}

export const SEGMENTS = ['sealed', 'used', 'parts'] as const;
export type Segment = (typeof SEGMENTS)[number];

/**
 * STAND-IN of #210's `segmentOf` ([VAL-7]): sealed is a `SET` or `OTHER` item in `SEALED`
 * condition; used is a `SET` or `OTHER` item in a used condition, and every `MINIFIG`; parts is
 * every `BULK` lot, beside the imported loose parts.
 */
export function segmentOf(item: { readonly kind: Kind; readonly condition: Condition }): Segment {
  switch (item.kind) {
    case 'BULK':
      return 'parts';
    case 'MINIFIG':
      return 'used';
    case 'SET':
    case 'OTHER':
      return item.condition === 'SEALED' ? 'sealed' : 'used';
  }
}
