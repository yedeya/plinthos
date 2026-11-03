/**
 * The public catalogue's data: what the publish step writes as `catalogue.json` and what the
 * page renderers read (brief #154, `docs/design/catalogue.md` § "Data the pages read"). Only the
 * public projection makes a value of this type ([PUB-5]); every field here is public.
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
}

/** The loose parts' summary ([PUB-14]): no value, no price and no lot list. */
export interface PublicParts {
  readonly lots: number;
  readonly quantity: number;
  readonly photos: readonly PublicPhoto[];
}

export interface PublicCatalogueData {
  /** 3 since #202: the kinds, and the set's fields nullable. */
  readonly format: 3;
  /** When this snapshot was published, ISO 8601. */
  readonly publishedAt: string;
  readonly introText: string;
  readonly contactText: string;
  /** Every published item: the sets by set number, then every other item by name. */
  readonly items: readonly PublicItem[];
  /** The parts summary, or null when no parts are imported. */
  readonly parts: PublicParts | null;
}

/** One file the page renderers return, which the publish step writes under `/c/{token}/`. */
export interface CataloguePage {
  /** Relative to the snapshot's root, e.g. `index.html`, `s/{id}/index.html`, `assets/catalogue.css`. */
  readonly path: string;
  readonly body: string;
  readonly contentType: string;
}
