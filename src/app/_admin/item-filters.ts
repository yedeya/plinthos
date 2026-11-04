/**
 * The filters, counts and sort of the item list on `/admin` (#251, [ITEM-14] to [ITEM-19]): pure
 * functions over what the page loaded and what the device's queue holds, run in the browser, so a
 * tap sends no request and works without a network. The list's state lives in the page's query
 * string ([ITEM-18]): `parseListQuery` reads it, ignoring anything it doesn't know, and
 * `listQueryString` writes it back, empty for the default list.
 *
 * Values are private (`[VAL-7]`), and so are *No value* and the value sort that read them; the
 * list is the admin's alone, so they leak nothing.
 */
import { CONDITIONS, KINDS, matchesFilter, type Condition, type ItemKind } from '../_offline/items';

/** The list's sorts ([ITEM-16]): each in one direction, date added first, the default. */
export const SORTS = ['added', 'value', 'year'] as const;
export type Sort = (typeof SORTS)[number];

/** Completeness's and instructions' options ([ITEM-14]): *not recorded* matches a null. */
export const YES_NO = ['yes', 'no', 'not-recorded'] as const;
export type YesNo = (typeof YES_NO)[number];

/** The *needs attention* options ([ITEM-15]). */
export const ATTENTION = ['no-value', 'incomplete-unnoted'] as const;
export type Attention = (typeof ATTENTION)[number];

/** The theme option of a set without a top-level theme, *Theme not known*; no theme's name is empty. */
export const UNKNOWN_THEME = '';

/** The filters, in the order the page shows them and the query string writes them. */
export const FILTER_KEYS = ['theme', 'condition', 'complete', 'instructions', 'kind', 'attention'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** The list's state: the text filter, the options chosen in each filter, and the sort. */
export interface ListQuery {
  readonly text: string;
  readonly theme: readonly string[];
  readonly condition: readonly Condition[];
  readonly complete: readonly YesNo[];
  readonly instructions: readonly YesNo[];
  readonly kind: readonly ItemKind[];
  readonly attention: readonly Attention[];
  readonly sort: Sort;
}

export const DEFAULT_QUERY: ListQuery = { text: '', theme: [], condition: [], complete: [], instructions: [], kind: [], attention: [], sort: 'added' };

/** The query string's words for the condition and kind options. */
const CONDITION_PARAM: Record<Condition, string> = { SEALED: 'sealed', USED_WITH_BOX: 'used-with-box', USED_NO_BOX: 'used-no-box' };
const KIND_PARAM: Record<ItemKind, string> = { SET: 'set', MINIFIG: 'minifig', BULK: 'bulk', OTHER: 'other' };

/** The longest text filter the query string keeps, as `listItems` takes it. */
const MAX_TEXT = 100;

/**
 * What the filters read of an item: a stored one as the server listed it, or a new one still in
 * the device's queue ([ITEM-19]).
 */
export interface Filterable {
  readonly kind: ItemKind;
  readonly setNum: string | null;
  readonly name: string | null;
  readonly refNo: string | null;
  readonly theme: string | null;
  /**
   * The set's top-level theme, null when it isn't known. Undefined for a queued item, whose theme
   * the queue doesn't hold: a queued set matches every theme option ([ITEM-19]).
   */
  readonly topTheme: string | null | undefined;
  readonly condition: Condition;
  readonly complete: boolean | null;
  readonly hasInstructions: boolean | null;
  readonly hasMissingNotes: boolean;
  /** Whether it has a BrickLink or a manual value ([VAL-5]); a queued new item has none. */
  readonly hasValue: boolean;
}

/** The theme options of the listed sets, by name, then *Theme not known* when a set has none ([ITEM-14]). */
export function themeOptions(items: readonly Filterable[]): string[] {
  const names = new Set<string>();
  let unknown = false;
  for (const item of items) {
    if (item.kind !== 'SET' || item.topTheme === undefined) continue;
    if (item.topTheme === null || item.topTheme === UNKNOWN_THEME) unknown = true;
    else names.add(item.topTheme);
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return unknown ? [...sorted, UNKNOWN_THEME] : sorted;
}

/** Every option of each filter, in the order the page shows them. */
export function filterOptions(themes: readonly string[]): { readonly [K in FilterKey]: readonly ListQuery[K][number][] } {
  return { theme: themes, condition: CONDITIONS, complete: YES_NO, instructions: YES_NO, kind: KINDS, attention: ATTENTION };
}

function yesNoOf(value: boolean | null): YesNo {
  return value === null ? 'not-recorded' : value ? 'yes' : 'no';
}

/** The options of `key` an item has; `'every'` for a queued set under the theme filter ([ITEM-19]). */
function optionsOf(item: Filterable, key: FilterKey): readonly string[] | 'every' {
  switch (key) {
    case 'theme':
      // A non-set matches no theme option; a queued set, every one.
      if (item.kind !== 'SET') return [];
      if (item.topTheme === undefined) return 'every';
      return [item.topTheme ?? UNKNOWN_THEME];
    case 'condition':
      return [item.condition];
    case 'complete':
      return [yesNoOf(item.complete)];
    case 'instructions':
      return [yesNoOf(item.hasInstructions)];
    case 'kind':
      return [item.kind];
    case 'attention':
      return [...(item.hasValue ? [] : ['no-value']), ...(item.complete === false && !item.hasMissingNotes ? ['incomplete-unnoted'] : [])];
  }
}

function hasAny(item: Filterable, key: FilterKey, chosen: readonly string[]): boolean {
  const own = optionsOf(item, key);
  return own === 'every' || own.some((option) => chosen.includes(option));
}

/** Whether an item is listed: it matches the text filter, and every filter but `except` that has an option chosen ([ITEM-14]). */
export function matchesQuery(item: Filterable, query: ListQuery, except?: FilterKey): boolean {
  if (!matchesFilter(item, query.text)) return false;
  return FILTER_KEYS.every((key) => key === except || query[key].length === 0 || hasAny(item, key, query[key]));
}

/**
 * Each option's count ([ITEM-17]): how many items the list would show with that option chosen
 * alone in its filter and every other filter as it is. Items, not their quantities.
 */
export function optionCounts(items: readonly Filterable[], query: ListQuery, themes: readonly string[]): { readonly [K in FilterKey]: ReadonlyMap<string, number> } {
  const options = filterOptions(themes);
  const counts = {} as { [K in FilterKey]: Map<string, number> };
  for (const key of FILTER_KEYS) {
    const map = new Map<string, number>(options[key].map((option) => [option, 0]));
    for (const item of items) {
      if (!matchesQuery(item, query, key)) continue;
      const own = optionsOf(item, key);
      for (const option of own === 'every' ? options[key] : own) map.set(option, (map.get(option) ?? 0) + 1);
    }
    counts[key] = map;
  }
  return counts;
}

/** How many options are chosen across the filters: what the **Filters** button shows. */
export function chosenCount(query: ListQuery): number {
  return FILTER_KEYS.reduce((sum, key) => sum + query[key].length, 0);
}

/** Whether the list is narrowed at all, by the text filter or a filter. */
export function isFiltered(query: ListQuery): boolean {
  return query.text.trim() !== '' || chosenCount(query) > 0;
}

/** The query with `option` chosen or no longer chosen in `key`, the options kept in the page's order. */
export function toggleOption<K extends FilterKey>(query: ListQuery, key: K, option: ListQuery[K][number], themes: readonly string[]): ListQuery {
  const chosen = query[key] as readonly string[];
  const next = chosen.includes(option) ? chosen.filter((value) => value !== option) : [...chosen, option];
  const order = filterOptions(themes)[key] as readonly string[];
  return { ...query, [key]: order.filter((value) => next.includes(value)) };
}

/** The sort's key of a stored item: what it sorts by, null for none, which comes last. */
export interface Sortable {
  readonly year: number | null;
  readonly value?: { readonly amount: number } | null;
}

/**
 * The stored items in the sort's order ([ITEM-16]). They arrive newest added first, as
 * `listItems` reads them; an item with no value, or with no year, comes after every item that has
 * one, newest added first among them. The queued items are not sorted: they stay above the list.
 */
export function sortItems<T extends Sortable>(items: readonly T[], sort: Sort): T[] {
  if (sort === 'added') return [...items];
  const keyOf = (item: T): number | null => (sort === 'value' ? (item.value?.amount ?? null) : item.year);
  return items
    .map((item, index) => ({ item, index, key: keyOf(item) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
      return b.key - a.key || a.index - b.index;
    })
    .map(({ item }) => item);
}

/** Only the known words of a repeated parameter, once each, in the page's order. */
function known<T extends string>(params: URLSearchParams, name: string, options: readonly T[], words: (option: T) => string = (option) => option): T[] {
  const given = new Set(params.getAll(name));
  return options.filter((option) => given.has(words(option)));
}

/**
 * The list's state from the page's query string ([ITEM-18]). An unknown or malformed value is
 * ignored, never an error: a theme no listed set has, a sort it doesn't know, a word of no option.
 */
export function parseListQuery(search: string, themes: readonly string[]): ListQuery {
  const params = new URLSearchParams(search);
  const sort = params.get('sort');
  return {
    text: (params.get('q') ?? '').slice(0, MAX_TEXT),
    theme: known(params, 'theme', themes),
    condition: known(params, 'condition', CONDITIONS, (option) => CONDITION_PARAM[option]),
    complete: known(params, 'complete', YES_NO),
    instructions: known(params, 'instructions', YES_NO),
    kind: known(params, 'kind', KINDS, (option) => KIND_PARAM[option]),
    attention: known(params, 'attention', ATTENTION),
    sort: SORTS.find((known) => known !== 'added' && known === sort) ?? 'added',
  };
}

/** The query string of the list's state, with its `?`, or empty for the default list ([ITEM-18]). */
export function listQueryString(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.text.trim() !== '') params.set('q', query.text.slice(0, MAX_TEXT));
  for (const theme of query.theme) params.append('theme', theme);
  for (const condition of query.condition) params.append('condition', CONDITION_PARAM[condition]);
  for (const complete of query.complete) params.append('complete', complete);
  for (const instructions of query.instructions) params.append('instructions', instructions);
  for (const kind of query.kind) params.append('kind', KIND_PARAM[kind]);
  for (const attention of query.attention) params.append('attention', attention);
  if (query.sort !== 'added') params.set('sort', query.sort);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
