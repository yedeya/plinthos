/**
 * A parts lot's quote key ([VAL-8]): the BrickLink type its letter maps to, its item number, its
 * colour for a part and `NO_COLOR` for anything else, and new or used by its condition. Every lot
 * with the same key shares one `part_price_quote` row, which the refresh asks for once and a lot's
 * value joins on (`partQuoteKeyOf` on both sides).
 */
import { NO_COLOR, type PartQuoteItemType } from '../../db/schema/part-price-quote';
import { bricklinkTypeOf } from './bricklink';

export interface PartQuoteKey {
  readonly itemType: PartQuoteItemType;
  readonly itemNo: string;
  readonly colorId: number;
  readonly newOrUsed: 'N' | 'U';
}

/** What of a parts lot its quote key is made of: `parts_lot`'s own columns. */
export interface PartsLotKeyFields {
  /** The file's one-letter item type. */
  readonly itemType: string;
  readonly itemNo: string;
  readonly colorId: number;
  readonly lotCondition: 'N' | 'U';
}

/** The quote a parts lot is priced by, or null for a lot whose type BrickLink doesn't price ([VAL-8]). */
export function partQuoteKeyOf(lot: PartsLotKeyFields): PartQuoteKey | null {
  const itemType = bricklinkTypeOf(lot.itemType);
  const itemNo = lot.itemNo.trim();
  if (itemType === null || itemNo === '') return null;
  return { itemType, itemNo, colorId: itemType === 'PART' ? lot.colorId : NO_COLOR, newOrUsed: lot.lotCondition };
}

/** One string per key, for a map. */
export function partQuoteKeyString(key: PartQuoteKey): string {
  return `${key.itemType}\u0000${key.itemNo}\u0000${key.colorId}\u0000${key.newOrUsed}`;
}
