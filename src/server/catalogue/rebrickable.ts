/**
 * STAND-IN for Issue A (#126, PR #129). This file holds only the interface Issue B builds
 * against, so the set lookup and the items compile before the Rebrickable client lands. Issue
 * A's real file replaces it whole: take A's version of this file when the branches meet.
 */

/** One set as the catalogue knows it ([CAT-1], [CAT-3]). */
export interface CatalogueSet {
  setNum: string;
  name: string;
  theme: string;
  year: number;
  numParts: number;
  imageUrl: string | null;
}

/** The set catalogue the lookup asks: Rebrickable when deployed, a stand-in in tests. */
export interface CatalogueProvider {
  searchSets(query: string, opts: { budgetMs: number }): Promise<CatalogueSet[]>;
  getSet(setNum: string, opts: { budgetMs: number }): Promise<CatalogueSet | null>;
}

export type CatalogueUnavailableReason = 'timeout' | 'rate-limited' | 'refused-key' | 'upstream';

/** The catalogue could not answer ([CAT-5]). */
export class CatalogueUnavailable extends Error {
  override name = 'CatalogueUnavailable';
  constructor(readonly reason: CatalogueUnavailableReason) {
    super(`The set catalogue is unavailable: ${reason}.`);
  }
}

/** Issue A's Rebrickable client. Not implemented in this stand-in. */
export function rebrickableProvider(...args: [apiKey: string, opts?: unknown]): CatalogueProvider {
  void args;
  throw new Error('not implemented: the Rebrickable client is Issue A (#126)');
}

/** Issue A's provider over the linked `RebrickableApiKey`. In this stand-in, every call is `refused-key`. */
export function linkedCatalogueProvider(...args: [opts?: unknown]): CatalogueProvider {
  void args;
  const refuse = async (): Promise<never> => {
    throw new CatalogueUnavailable('refused-key');
  };
  return { searchSets: refuse, getSet: refuse };
}
