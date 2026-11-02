/**
 * A made-up public catalogue for the page renderers' tests (brief #154, Issue B): several items
 * over every condition and three themes, one incomplete, one without any image, and loose parts.
 * Every value is invented.
 */
import type { PublicCatalogueData, PublicItem } from '../../../../src/server/publish/catalogue-data';

export const STOCK = 'https://cdn.rebrickable.test/media/sets/made-up.jpg';

const photo = (n: string) => ({ full: `p/made-up-full-${n}.webp`, thumb: `p/made-up-thumb-${n}.webp` });

export function item(overrides: Partial<PublicItem> & Pick<PublicItem, 'id' | 'setNum' | 'name'>): PublicItem {
  return {
    kind: 'SET',
    refNo: null,
    approxParts: null,
    approxWeightG: null,
    theme: 'Made-up Town',
    year: 2020,
    numParts: 500,
    condition: 'SEALED',
    complete: true,
    missingNotes: null,
    hasInstructions: true,
    description: '',
    quantity: 1,
    stockImageUrl: STOCK,
    photos: [],
    ...overrides,
  };
}

export const items: PublicItem[] = [
  item({ id: 'item-a', setNum: '7140-1', name: 'Made-up X-wing', theme: 'Made-up Space', year: 1999, numParts: 263, condition: 'USED_NO_BOX', complete: false, missingNotes: 'Two made-up grey plates', hasInstructions: false, quantity: 2, photos: [photo('a1'), photo('a2')] }),
  item({ id: 'item-b', setNum: '10294-1', name: 'Made-up Liner', theme: 'Made-up Icons', year: 2021, numParts: 9090, description: 'Made-up description.\nSecond line.', photos: [photo('b1'), photo('b2'), photo('b3')] }),
  item({ id: 'item-c', setNum: '21318-1', name: 'Made-up Tree House', theme: 'Made-up Icons', year: 2019, numParts: 3036, condition: 'USED_WITH_BOX', quantity: 3, stockImageUrl: null, photos: [photo('c1')] }),
  item({ id: 'item-d', setNum: '60000-1', name: 'Made-up Bike', year: 2013, numParts: 40, condition: 'USED_WITH_BOX', stockImageUrl: null }),
];

/** A made-up item that is not a set (#202): no set number, theme, year, piece count or stock image. */
export function other(overrides: Partial<PublicItem> & Pick<PublicItem, 'id' | 'kind' | 'name'>): PublicItem {
  return item({ setNum: null, theme: null, year: null, numParts: null, stockImageUrl: null, complete: null, hasInstructions: null, condition: 'USED_NO_BOX', ...overrides });
}

/** One of each kind that is not a set, in the order the catalogue sorts them after the sets: by name. */
export const others: PublicItem[] = [
  other({ id: 'item-m', kind: 'MINIFIG', name: 'Made-up Captain', refNo: 'mu0001', complete: true }),
  other({ id: 'item-k', kind: 'OTHER', name: 'Made-up Keychain' }),
  other({ id: 'item-z', kind: 'BULK', name: 'Made-up Mixed Bricks', approxParts: 2500, approxWeightG: 3200, complete: false, missingNotes: 'Made-up: unsorted', photos: [photo('z1')] }),
];

export function catalogue(overrides: Partial<PublicCatalogueData> = {}): PublicCatalogueData {
  return {
    format: 3,
    publishedAt: '2026-11-02T10:00:00.000Z',
    introText: 'A made-up collection of sets.',
    contactText: 'Write to the made-up owner.',
    items,
    parts: { lots: 1930, quantity: 48210, photos: [photo('parts1'), photo('parts2')] },
    ...overrides,
  };
}
