/**
 * The public catalogue's data: what the publish step writes as `catalogue.json` and what the
 * page renderers read (brief #154, `docs/design/catalogue.md` § "Data the pages read"). Only the
 * public projection makes a value of this type ([PUB-5]); every field here is public.
 */

export type PublicCondition = 'SEALED' | 'USED_WITH_BOX' | 'USED_NO_BOX';

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
  readonly setNum: string;
  readonly name: string;
  readonly theme: string;
  readonly year: number;
  readonly numParts: number;
  readonly condition: PublicCondition;
  readonly complete: boolean;
  /** What is missing, only when the item isn't complete; null otherwise. */
  readonly missingNotes: string | null;
  readonly hasInstructions: boolean;
  readonly description: string;
  readonly quantity: number;
  /** The catalogue's stock image, an absolute `https://` URL, or null. */
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
  readonly format: 2;
  /** When this snapshot was published, ISO 8601. */
  readonly publishedAt: string;
  readonly introText: string;
  readonly contactText: string;
  /** Every published item, sorted by set number. */
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
