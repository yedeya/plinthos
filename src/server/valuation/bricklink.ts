/**
 * STAND-IN for #209's BrickLink client (brief #207, Issue A). It holds exactly the interface
 * Issue B builds against, and nothing else: no request, no signing, no secret. At merge #209's
 * real file replaces this one whole. Until then the deployed provider refuses every request as
 * `refused-key`, so a refresh stops at once and keeps every price it had ([VAL-4]).
 */

export type PriceItemType = 'SET' | 'MINIFIG';
/** `N` for a sealed set, `U` for a used one ([VAL-2]). */
export type NewOrUsed = 'N' | 'U';

/** One price-guide answer ([VAL-2]): the six-month sold average, null when nothing sold. */
export interface PriceGuide {
  itemType: PriceItemType;
  itemNo: string;
  newOrUsed: NewOrUsed;
  /** The average sale price in `currency`, or null when the item had no sale in six months. */
  average: number | null;
  sampleSize: number;
  /** The ISO 4217 code BrickLink answered in. */
  currency: string;
}

/** What a call may spend, retries included ([VAL-1]), and the signal that says its caller gave up. */
export interface PriceCallOptions {
  budgetMs: number;
  signal?: AbortSignal;
}

export interface PriceProvider {
  /** The price guide for one item, or null when BrickLink doesn't know it. Throws `PriceUnavailable`. */
  priceGuide(itemType: PriceItemType, itemNo: string, newOrUsed: NewOrUsed, opts: PriceCallOptions): Promise<PriceGuide | null>;
}

/** `aborted`: the caller gave up first, so nothing failed. */
export type PriceUnavailableReason = 'timeout' | 'rate-limited' | 'refused-key' | 'upstream' | 'aborted';

/** BrickLink gave no answer: why, never a secret or a URL. */
export class PriceUnavailable extends Error {
  override name = 'PriceUnavailable';
  constructor(readonly reason: PriceUnavailableReason) {
    super(`BrickLink's price guide is unavailable: ${reason}`);
  }
}

/** STAND-IN: the deployed provider. #209's reads the four secrets; this one has none, so it refuses. */
export function linkedPriceProvider(): PriceProvider {
  return {
    priceGuide: () => Promise.reject(new PriceUnavailable('refused-key')),
  };
}
