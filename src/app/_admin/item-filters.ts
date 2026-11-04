/**
 * The filters, counts, sort and query string of the item list on `/admin` (brief #251, Issue C,
 * [ITEM-14] to [ITEM-19]): pure functions over the list the page loaded and the items still in the
 * device's queue. Nothing here sends a request, so the list answers as the owner taps and keeps
 * working when the network drops. It imports nothing of the server's, so the client bundle takes it.
 *
 * - **A filter** is a set of chosen options; none chosen is the filter off. An item matches a
 *   filter when it has any of the chosen options, and is listed when it matches every filter and
 *   the text filter ([ITEM-14]).
 * - **A count** is how many items the list would show with that option chosen alone in its filter
 *   and every other filter as it is ([ITEM-17]).
 * - **The sort** is by date added, the server's order, by value or by year ([ITEM-16]).
 * - **The query string** holds all of it, and the default list has none ([ITEM-18]).
 */
import { CONDITIONS, KINDS, matchesFilter, type Condition, type ItemKind, type ListedItem, type QueuedItem } from '../_offline/items';

/** Completeness and instructions: yes, no, or not recorded, a null field ([ITEM-10], [ITEM-14]). */
export const YES_NO = ['yes', 'no', 'unknown'] as const;
export type YesNo = (typeof YES_NO)[number];

/** The *needs attention* options ([ITEM-15]): no value, and incomplete with nothing noted. */
export const ATTENTION = ['no-value', 'incomplete-unnoted'] as const;
export type Attention = (typeof ATTENTION)[number];

/** The sorts ([ITEM-16]), the first the default. */
export const SORTS = ['added', 'value', 'year'] as const;
export type Sort = (typeof SORTS)[number];

/** The theme option of a set whose top-level theme isn't known yet ([ITEM-14]): no theme's name is empty. */
export const THEME_UNKNOWN = '';

/** The filters, in the order the page shows them. */
export const FILTER_NAMES = ['theme', 'condition', 'complete', 'instructions', 'kind', 'attention'] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

/** The longest text filter the query string is read with: the box's own limit. */
export const TEXT_MAX = 100;

export interface ListFilters {
  readonly text: string;
  /** Top-level themes by name, and `THEME_UNKNOWN`. */
  readonly theme: readonly string[];
  readonly condition: readonly Condition[];
  readonly complete: readonly YesNo[];
  readonly instructions: readonly YesNo[];
  readonly kind: readonly ItemKind[];
  readonly attention: readonly Attention[];
}

export interface ListView {
  readonly filters: ListFilters;
  readonly sort: Sort;
}

export const NO_FILTERS: ListFilters = { text: '', theme: [], condition: [], complete: [], instructions: [], kind: [], attention: [] };
export const DEFAULT_VIEW: ListView = { filters: NO_FILTERS, sort: 'added' };

/** What a filter reads of an item, a stored one or one still in the device's queue. */
export interface FilterSubject {
  readonly kind: ItemKind;
  readonly setNum: string | null;
  readonly name: string | null;
  readonly refNo: string | null;
  readonly theme: string | null;
  readonly topTheme: string | null;
  readonly condition: Condition;
  readonly complete: boolean | null;
  readonly hasInstructions: boolean | null;
  readonly hasMissingNotes: boolean;
  readonly hasValue: boolean;
  /** A new item still in the queue, which holds no theme ([ITEM-19]). */
  readonly queued: boolean;
}

export function listedSubject(item: ListedItem): FilterSubject {
  return {
    kind: item.kind,
    setNum: item.setNum,
    name: item.name,
    refNo: item.refNo,
    theme: item.theme,
    topTheme: item.topTheme,
    condition: item.condition,
    complete: item.complete,
    hasInstructions: item.hasInstructions,
    hasMissingNotes: item.hasMissingNotes,
    hasValue: item.value !== undefined && item.value !== null,
    queued: false,
  };
}

/** A new item in the queue, filtered on what the queue holds; it has no value yet ([ITEM-19]). */
export function queuedSubject(item: QueuedItem): FilterSubject {
  return {
    kind: item.kind,
    setNum: item.setNum,
    name: item.name,
    refNo: item.refNo,
    theme: null,
    topTheme: null,
    condition: item.condition,
    complete: item.complete,
    hasInstructions: item.hasInstructions,
    hasMissingNotes: item.hasMissingNotes,
    hasValue: false,
    queued: true,
  };
}

/** The theme options: the listed sets' top-level themes by name, then *Theme not known* when a set has none ([ITEM-14]). */
export function themeOptions(items: readonly Pick<ListedItem, 'kind' | 'topTheme'>[]): string[] {
  const sets = items.filter((item) => item.kind === 'SET');
  const named = [...new Set(sets.flatMap((item) => (item.topTheme === null || item.topTheme === THEME_UNKNOWN ? [] : [item.topTheme])))];
  named.sort((a, b) => a.localeCompare(b));
  return sets.some((item) => item.topTheme === null || item.topTheme === THEME_UNKNOWN) ? [...named, THEME_UNKNOWN] : named;
}

/** Every filter's options, in the order the page offers them. */
export function filterOptions(themes: readonly string[]): { readonly [F in FilterName]: readonly ListFilters[F][number][] } {
  return { theme: themes, condition: CONDITIONS, complete: YES_NO, instructions: YES_NO, kind: KINDS, attention: ATTENTION };
}

function yesNoOf(value: boolean | null): YesNo {
  return value === null ? 'unknown' : value ? 'yes' : 'no';
}

/** Whether an item has one option of a filter. */
function hasOption(subject: FilterSubject, filter: FilterName, option: string): boolean {
  switch (filter) {
    case 'theme':
      // A non-set matches no theme; the queue holds no theme, so a queued set matches every one.
      if (subject.kind !== 'SET') return false;
      return subject.queued || (subject.topTheme ?? THEME_UNKNOWN) === option;
    case 'condition':
      return subject.condition === option;
    case 'complete':
      return yesNoOf(subject.complete) === option;
    case 'instructions':
      return yesNoOf(subject.hasInstructions) === option;
    case 'kind':
      return subject.kind === option;
    case 'attention':
      return option === 'no-value' ? !subject.hasValue : subject.complete === false && !subject.hasMissingNotes;
  }
}

/** Whether an item is listed: it matches the text filter and every filter but `except`. */
function matchesAllBut(subject: FilterSubject, filters: ListFilters, except: FilterName | null): boolean {
  if (!matchesFilter(subject, filters.text)) return false;
  return FILTER_NAMES.every((filter) => filter === except || filters[filter].length === 0 || filters[filter].some((option) => hasOption(subject, filter, option)));
}

/** Whether an item is listed under these filters ([ITEM-14]). */
export function matchesView(subject: FilterSubject, filters: ListFilters): boolean {
  return matchesAllBut(subject, filters, null);
}

/**
 * How many items each option would list, chosen alone in its filter with every other filter as it
 * is, counting items rather than their quantities; every option is there, 0 included ([ITEM-17]).
 */
export function optionCounts(subjects: readonly FilterSubject[], filters: ListFilters, themes: readonly string[]): { readonly [F in FilterName]: ReadonlyMap<string, number> } {
  const options = filterOptions(themes);
  const counts = {} as Record<FilterName, Map<string, number>>;
  for (const filter of FILTER_NAMES) {
    const rest = subjects.filter((subject) => matchesAllBut(subject, filters, filter));
    counts[filter] = new Map(options[filter].map((option) => [option, rest.filter((subject) => hasOption(subject, filter, option)).length]));
  }
  return counts;
}

/** How many filters are on, for the **Filters** button; the text filter and the sort are not filters it counts. */
export function activeFilterCount(filters: ListFilters): number {
  return FILTER_NAMES.filter((filter) => filters[filter].length > 0).length;
}

/**
 * The stored items in a sort ([ITEM-16]), from the server's order, newest added first. By value,
 * highest first; by year, newest first. An item with no value, or a non-set, which has no year,
 * comes after every item that has one, and the sort is stable, so ties stay newest added first.
 * The amount is compared alone: a value in another currency than the rest is rare (`[VAL-5]`'s
 * override in its own currency) and still sorts by its number.
 */
export function sortListed<T extends Pick<ListedItem, 'value' | 'year' | 'kind'>>(items: readonly T[], sort: Sort): T[] {
  const key = (item: T): number | null => (sort === 'value' ? (item.value?.amount ?? null) : item.kind === 'SET' ? item.year : null);
  if (sort === 'added') return [...items];
  return [...items].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return y - x;
  });
}

/** The query string's names. */
const PARAM: { readonly [F in keyof ListFilters | 'sort']: string } = {
  text: 'q',
  theme: 'theme',
  condition: 'condition',
  complete: 'complete',
  instructions: 'instructions',
  kind: 'kind',
  attention: 'attention',
  sort: 'sort',
};

/** How an option is written in the query string, where it isn't its own name. */
const TOKEN: { readonly [F in FilterName]?: Readonly<Record<string, string>> } = {
  condition: { SEALED: 'sealed', USED_WITH_BOX: 'used-box', USED_NO_BOX: 'used-no-box' } satisfies Record<Condition, string>,
  kind: { SET: 'set', MINIFIG: 'minifig', BULK: 'bulk', OTHER: 'other' } satisfies Record<ItemKind, string>,
};

function tokenOf(filter: FilterName, option: string): string {
  return TOKEN[filter]?.[option] ?? option;
}

type Query = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

function valuesOf(query: Query, name: string): readonly string[] {
  if (query instanceof URLSearchParams) return query.getAll(name);
  const value = query[name];
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

/**
 * The view a query string names ([ITEM-18]): each filter's known options in the page's order, the
 * first text filter cut to `TEXT_MAX`, and a known sort. An unknown or malformed value is
 * ignored, never an error, and so is a theme the listed sets don't have.
 */
export function readView(query: Query, themes: readonly string[]): ListView {
  const options = filterOptions(themes);
  const chosen = <F extends FilterName>(filter: F): ListFilters[F] => {
    const given = new Set(valuesOf(query, PARAM[filter]));
    return options[filter].filter((option) => given.has(tokenOf(filter, option))) as unknown as ListFilters[F];
  };
  const sort = valuesOf(query, PARAM.sort)[0];
  return {
    filters: {
      text: (valuesOf(query, PARAM.text)[0] ?? '').slice(0, TEXT_MAX),
      theme: chosen('theme'),
      condition: chosen('condition'),
      complete: chosen('complete'),
      instructions: chosen('instructions'),
      kind: chosen('kind'),
      attention: chosen('attention'),
    },
    sort: SORTS.find((known) => known === sort) ?? 'added',
  };
}

/** The query string for a view, without its `?`: empty for the default list ([ITEM-18]). */
export function viewQuery(view: ListView): string {
  const params = new URLSearchParams();
  if (view.filters.text.trim() !== '') params.set(PARAM.text, view.filters.text);
  for (const filter of FILTER_NAMES) for (const option of view.filters[filter]) params.append(PARAM[filter], tokenOf(filter, option));
  if (view.sort !== 'added') params.set(PARAM.sort, view.sort);
  return params.toString();
}
