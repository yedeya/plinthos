/**
 * The public catalogue's data: what the publish step writes as `catalogue.json` and what the
 * page renderers read (brief #154, `docs/design/catalogue.md` § "Data the pages read"). Only the
 * public projection makes a value of this type ([PUB-5]); every field here is public.
 *
 * **Values and selling mode (#211, format 4).** The value fields are optional, and a field the
 * settings hide is **absent**: never `null`, never zero, never an empty object. So a snapshot
 * under settings that show no value has exactly the keys a format-3 snapshot had, and nothing in
 * it says whether a value is stored ([PUB-17], [PUB-18]). Where a field is present, it holds only
 * what the settings show, and every total is the sum of the values the snapshot itself holds.
 */

export type PublicCondition = 'SEALED' | 'USED_WITH_BOX' | 'USED_NO_BOX';

/** What an item is (#202): a set, a minifigure, a bulk or unsorted lot, or another LEGO item. */
export type PublicKind = 'SET' | 'MINIFIG' | 'BULK' | 'OTHER';

/** One published photo: paths relative to the snapshot's root, `/c/{token}/`, never a private key. */
export interface PublicPhoto {
  /** The full size, e.g. `p/<random>.webp`. */
  readonly full: string;
  /** The 320 px thumbnail, e.g. `p/<random>.webp`. */
  readonly thumb: string;
}

export interface PublicItem {
  /** The item's id, which its page's path names: `s/{id}/`. */
  readonly id: string;
  readonly kind: PublicKind;
  /** The set's catalogue number; null for every kind but `SET`. */
  readonly setNum: string | null;
  /** The display name, always: a set's catalogue name, or a non-set's own. */
  readonly name: string;
  /** A figure number or a BrickLink item number, when the owner gave one. */
  readonly refNo: string | null;
  /** The set's catalogue facts; null for a non-set, which has no catalogue row. */
  readonly theme: string | null;
  readonly year: number | null;
  readonly numParts: number | null;
  /** A bulk lot's approximate piece count and weight in grams; null otherwise. */
  readonly approxParts: number | null;
  readonly approxWeightG: number | null;
  readonly condition: PublicCondition;
  /** Null when a non-set's completeness is not stated. */
  readonly complete: boolean | null;
  /** What is missing, only when the item is stated incomplete; null otherwise. */
  readonly missingNotes: string | null;
  /** Null when a non-set's instructions are not stated. */
  readonly hasInstructions: boolean | null;
  readonly description: string;
  readonly quantity: number;
  /** The catalogue's stock image, an absolute `https://` URL, or null; always null for a non-set. */
  readonly stockImageUrl: string | null;
  /** The owner's photos in order, the cover first. */
  readonly photos: readonly PublicPhoto[];
  /**
   * The item's estimated market value for its whole quantity, in the catalogue's `valueCurrency`:
   * present only while the settings show market values and the item has one ([PUB-17]).
   */
  readonly value?: number;
  /**
   * The day the value is estimated as of, `YYYY-MM-DD`: its BrickLink quote's day, or the
   * publish's own day for the owner's estimate. Present exactly when `value` is.
   */
  readonly asOf?: string;
  /**
   * The split view the item is in, by `segmentOf` (`src/server/valuation/values.ts`, [VAL-7]):
   * present only in selling mode ([PUB-19]). A bulk lot is in `parts`, with the loose parts.
   */
  readonly segment?: PublicSegment;
}

/** One lot of the parts download ([PUB-20]): its BrickLink item type, number, colour, condition and quantity. */
export interface PublicLot {
  readonly type: string;
  readonly no: string;
  readonly color: number;
  readonly condition: 'N' | 'U';
  readonly quantity: number;
  /** The lot's unit price, in the catalogue's `valueCurrency`: present only while market values are shown. */
  readonly price?: number;
}

/**
 * The loose parts' summary ([PUB-14]): with selling mode off, no value, no price and no lot list.
 */
export interface PublicParts {
  readonly lots: number;
  readonly quantity: number;
  readonly photos: readonly PublicPhoto[];
  /** The loose parts' estimated value, in `valueCurrency`: present only while market values are shown. */
  readonly value?: number;
  /** The lots, for the parts download: present only in selling mode ([PUB-20]). */
  readonly list?: readonly PublicLot[];
}

/** The split views selling mode adds ([PUB-19]), the segments of `segmentOf` ([VAL-7]): sealed, used and the loose parts with the bulk lots. */
export type PublicSegment = 'sealed' | 'used' | 'parts';

/**
 * The estimated market totals, each the sum of the values this snapshot holds ([PUB-17]): `all`
 * over every item and the loose parts, then per segment (`segmentOf`; `parts` is the loose parts'
 * value and every bulk lot's). Every amount is in `valueCurrency`: a value in another currency is
 * not published, so no total adds two currencies. A segment with no shown value is absent.
 */
export interface PublicTotals {
  readonly all: number;
  readonly sealed?: number;
  readonly used?: number;
  readonly parts?: number;
}

/** The owner's asking prices in selling mode ([PUB-18]): each present only when entered. */
export interface PublicAsking {
  readonly total?: number;
  readonly sealed?: number;
  readonly used?: number;
  readonly parts?: number;
}

export interface PublicCatalogueData {
  /** 4 since #211: the optional value and selling fields. 3 since #202: the kinds, and the set's fields nullable. */
  readonly format: 4;
  /** When this snapshot was published, ISO 8601. */
  readonly publishedAt: string;
  readonly introText: string;
  readonly contactText: string;
  /** Every published item: the sets by set number, then every other item by name. */
  readonly items: readonly PublicItem[];
  /** The parts summary, or null when no parts are imported. */
  readonly parts: PublicParts | null;
  /**
   * The currency every amount is in, ISO 4217: present only when an amount is. Not `currency`,
   * which is a private column's name ([PUB-4]'s key check).
   */
  readonly valueCurrency?: string;
  /** Present only while market values are shown and at least one is held ([PUB-17]). */
  readonly totals?: PublicTotals;
  /** Present only in selling mode, with the display `ASKING` or `BOTH`, and an asking price entered ([PUB-18]). */
  readonly asking?: PublicAsking;
  /** The split views, those with anything in them: present only in selling mode ([PUB-19]). */
  readonly segments?: readonly PublicSegment[];
}

/** One file the page renderers return, which the publish step writes under `/c/{token}/`. */
export interface CataloguePage {
  /** Relative to the snapshot's root, e.g. `index.html`, `s/{id}/index.html`, `assets/catalogue.css`. */
  readonly path: string;
  readonly body: string;
  readonly contentType: string;
}
