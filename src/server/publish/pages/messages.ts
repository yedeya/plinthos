/**
 * Every text the public catalogue shows a visitor, in one place (`HANDOVER.md` §10.9, brief #154):
 * a translation is a second file of this shape. Nothing here is about one owner: the owner's own
 * words, the intro and the contact text, come from the data.
 */
import type { PublicCondition } from '../catalogue-data';

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
  summary: {
    label: 'Summary',
    totals: (sets: number, items: number) => `${plural(sets, 'set', 'sets')} · ${plural(items, 'item', 'items')}`,
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
    sort: 'Sort',
    sortBy: {
      setNum: 'Set number',
      year: 'Year',
      name: 'Name',
    },
    noMatch: 'No sets match these filters.',
    nothing: 'Nothing is published yet.',
    meta: (theme: string, year: number) => `${theme} · ${year}`,
    noPhoto: 'No photo',
  },
  set: {
    back: '← All sets',
    meta: (theme: string, year: number, pieces: number) => `${theme} · ${year} · ${plural(pieces, 'piece', 'pieces')}`,
    details: 'Details',
    condition: 'Condition',
    complete: 'Complete',
    missing: "What's missing",
    instructions: 'Instructions',
    quantity: 'Quantity',
    description: 'Description',
    yes: 'Yes',
    no: 'No',
    title: (setNum: string, name: string) => `${setNum} ${name}`,
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
