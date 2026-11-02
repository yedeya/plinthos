/**
 * Every text the public catalogue shows a visitor, in one place (`HANDOVER.md` §10.9, brief #154):
 * a translation is a second file of this shape. Nothing here is about one owner: the owner's own
 * words, the intro and the contact text, come from the data.
 */
import type { PublicCondition, PublicKind } from '../catalogue-data';

const number = (value: number): string => value.toLocaleString('en');
const plural = (count: number, one: string, many: string): string => `${number(count)} ${count === 1 ? one : many}`;

export const catalogueMessages = {
  lang: 'en',
  wordmark: 'Plinthos',
  tagline: 'A LEGO collection',
  condition: {
    SEALED: 'Sealed',
    USED_WITH_BOX: 'Used, box',
    USED_NO_BOX: 'Used, no box',
  } satisfies Record<PublicCondition, string>,
  /** What an item is (#202), as a card's and a page's label. */
  kind: {
    SET: 'Set',
    MINIFIG: 'Minifigure',
    BULK: 'Bulk lot',
    OTHER: 'Other item',
  } satisfies Record<PublicKind, string>,
  /** A bulk lot's approximate numbers (#202), each left out when the owner gave none. */
  approx: (parts: number | null, weightG: number | null) =>
    [parts === null ? null : `about ${plural(parts, 'piece', 'pieces')}`, weightG === null ? null : `about ${number(weightG)} g`].filter((part) => part !== null).join(' · '),
  summary: {
    label: 'Summary',
    /** The sets, the other items when there are any (#202), and every item counted by its quantity. */
    totals: (sets: number, others: number, items: number) =>
      [plural(sets, 'set', 'sets'), others === 0 ? null : `${number(others)} other`, plural(items, 'item', 'items')].filter((part) => part !== null).join(' · '),
    perCondition: (label: string, count: number) => `${label} ${number(count)}`,
    parts: (quantity: number, lots: number) => `Loose parts ${number(quantity)} in ${plural(lots, 'lot', 'lots')}`,
  },
  grid: {
    heading: 'Sets',
    filters: 'Filter and sort',
    condition: 'Condition',
    allConditions: 'All',
    theme: 'Theme',
    allThemes: 'All themes',
    kind: 'Kind',
    allKinds: 'All kinds',
    kinds: {
      SET: 'Sets',
      MINIFIG: 'Minifigures',
      BULK: 'Bulk lots',
      OTHER: 'Other items',
    } satisfies Record<PublicKind, string>,
    sort: 'Sort',
    sortBy: {
      setNum: 'Set number',
      year: 'Year',
      name: 'Name',
    },
    noMatch: 'Nothing matches these filters.',
    nothing: 'Nothing is published yet.',
    meta: (theme: string, year: number) => `${theme} · ${year}`,
    noPhoto: 'No photo',
  },
  set: {
    back: '← All items',
    meta: (theme: string, year: number, pieces: number) => `${theme} · ${year} · ${plural(pieces, 'piece', 'pieces')}`,
    details: 'Details',
    condition: 'Condition',
    complete: 'Complete',
    missing: "What's missing",
    instructions: 'Instructions',
    quantity: 'Quantity',
    refNo: 'Reference number',
    approxParts: 'Approximate pieces',
    approxWeight: 'Approximate weight',
    count: (value: number) => number(value),
    grams: (weightG: number) => `${number(weightG)} g`,
    description: 'Description',
    yes: 'Yes',
    no: 'No',
    /** A set by its number and name; any other item by its name alone (#202). */
    title: (setNum: string | null, name: string) => (setNum === null ? name : `${setNum} ${name}`),
  },
  gallery: {
    label: 'Photos',
    thumbs: 'Choose a photo',
    previous: 'Previous photo',
    next: 'Next photo',
    none: 'No photos yet.',
    photoAlt: (subject: string, position: number, count: number) => `${subject}, photo ${position} of ${count}`,
    stockAlt: (name: string) => `Box of ${name}, catalogue image`,
    show: (position: number) => `Show photo ${position}`,
  },
  parts: {
    heading: 'Loose parts',
    title: 'Loose parts',
    subject: 'Loose parts',
    summary: (quantity: number, lots: number) => `${plural(quantity, 'part', 'parts')} in ${plural(lots, 'lot', 'lots')}`,
    open: 'See the loose parts',
  },
  contact: {
    heading: 'Contact',
  },
  intro: {
    label: 'About this collection',
  },
  published: (at: string) => `Updated ${at}`,
} as const;

export type CatalogueMessages = typeof catalogueMessages;

/** When a snapshot was published, as a visitor reads it, in UTC so every build says the same. */
export function publishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}
