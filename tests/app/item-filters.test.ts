import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY,
  listQueryString,
  matchesQuery,
  optionCounts,
  parseListQuery,
  sortItems,
  themeOptions,
  toggleOption,
  UNKNOWN_THEME,
  type Filterable,
  type ListQuery,
} from '../../src/app/_admin/item-filters';

/**
 * The item list's filters, counts and sort (#251, [ITEM-14] to [ITEM-19]), as pure functions over
 * made-up items. Every name and number here is made up.
 */

function item(overrides: Partial<Filterable> & { readonly id: string }): Filterable & { readonly id: string } {
  return {
    kind: 'SET',
    setNum: '990001-1',
    name: 'Made-up set',
    refNo: null,
    theme: 'Made-up leaf',
    topTheme: 'Made-up Pirates',
    condition: 'USED_WITH_BOX',
    complete: true,
    hasInstructions: true,
    hasMissingNotes: false,
    hasValue: true,
    ...overrides,
  };
}

const pirates = item({ id: 'pirates', theme: 'Made-up Islanders', topTheme: 'Made-up Pirates', condition: 'SEALED' });
const ninjas = item({ id: 'ninjas', setNum: '990002-1', name: 'Made-up dojo', theme: 'Made-up Ninjas', topTheme: 'Made-up Ninjas', complete: false, hasMissingNotes: false, hasValue: false });
const noted = item({ id: 'noted', setNum: '990003-1', topTheme: 'Made-up Ninjas', complete: false, hasMissingNotes: true, hasInstructions: false, condition: 'USED_NO_BOX' });
const unknown = item({ id: 'unknown', setNum: '990004-1', topTheme: null });
const figure = item({ id: 'figure', kind: 'MINIFIG', setNum: null, name: 'Made-up diver', refNo: 'mu0001', theme: null, topTheme: null, complete: null, hasInstructions: null, hasValue: false });
const lot = item({ id: 'lot', kind: 'BULK', setNum: null, name: 'Made-up tub', theme: null, topTheme: null, complete: true, hasInstructions: null, condition: 'USED_NO_BOX' });
// A new set still in the device's queue: no theme, and no value.
const queuedSet = item({ id: 'queued', setNum: '990005-1', name: null, theme: null, topTheme: undefined, hasValue: false });
const all = [queuedSet, pirates, ninjas, noted, unknown, figure, lot];

const themes = themeOptions(all);
const ids = (query: ListQuery) => all.filter((one) => matchesQuery(one, query)).map((one) => one.id);
const q = (overrides: Partial<ListQuery>): ListQuery => ({ ...DEFAULT_QUERY, ...overrides });

describe('the item list’s filters', () => {
  it('[ITEM-14] offers the listed sets’ top-level themes by name, then Theme not known, and a non-set matches none', () => {
    expect(themes).toEqual(['Made-up Ninjas', 'Made-up Pirates', UNKNOWN_THEME]);
    expect(ids(q({ theme: ['Made-up Ninjas'] }))).toEqual(['queued', 'ninjas', 'noted']);
    expect(ids(q({ theme: [UNKNOWN_THEME] }))).toEqual(['queued', 'unknown']);
    expect(ids(q({ theme: ['Made-up Pirates', UNKNOWN_THEME] }))).toEqual(['queued', 'pirates', 'unknown']);
  });

  it('[ITEM-14] matches any chosen option within a filter and every filter together, with the text filter matching the theme and top-level theme', () => {
    expect(ids(q({ condition: ['SEALED', 'USED_NO_BOX'] }))).toEqual(['pirates', 'noted', 'lot']);
    expect(ids(q({ condition: ['USED_NO_BOX'], kind: ['SET'] }))).toEqual(['noted']);
    expect(ids(q({ kind: ['MINIFIG', 'BULK'] }))).toEqual(['figure', 'lot']);
    expect(ids(q({ text: 'islanders' }))).toEqual(['pirates']);
    expect(ids(q({ text: 'ninjas', complete: ['no'] }))).toEqual(['ninjas', 'noted']);
    expect(ids(q({ text: 'MU0001' }))).toEqual(['figure']);
  });

  it('[ITEM-14] matches not recorded on a null in that field alone, whatever the other holds', () => {
    expect(ids(q({ complete: ['not-recorded'] }))).toEqual(['figure']);
    expect(ids(q({ instructions: ['not-recorded'] }))).toEqual(['figure', 'lot']);
    expect(ids(q({ instructions: ['no'] }))).toEqual(['noted']);
    expect(ids(q({ complete: ['yes'], instructions: ['not-recorded'] }))).toEqual(['lot']);
  });

  it('[ITEM-15] needs attention: no value, and incomplete with nothing noted, and nothing else', () => {
    expect(ids(q({ attention: ['no-value'] }))).toEqual(['queued', 'ninjas', 'figure']);
    expect(ids(q({ attention: ['incomplete-unnoted'] }))).toEqual(['ninjas']);
    expect(ids(q({ attention: ['no-value', 'incomplete-unnoted'] }))).toEqual(['queued', 'ninjas', 'figure']);
    expect(parseListQuery('attention=no-photo&attention=hidden', themes).attention).toEqual([]);
  });

  it('[ITEM-19] a queued set matches every theme option and the theme filter never hides it; every other filter applies to what the queue holds', () => {
    for (const theme of themes) expect(matchesQuery(queuedSet, q({ theme: [theme] })), theme).toBe(true);
    expect(matchesQuery(queuedSet, q({ condition: ['SEALED'] }))).toBe(false);
    expect(matchesQuery(queuedSet, q({ complete: ['yes'], instructions: ['yes'], kind: ['SET'] }))).toBe(true);
    expect(matchesQuery(queuedSet, q({ kind: ['MINIFIG'] }))).toBe(false);
    expect(matchesQuery(queuedSet, q({ text: '990005' }))).toBe(true);
    // A queued item holds no theme, so the theme it doesn't hold is not what the text filter matches.
    expect(matchesQuery(queuedSet, q({ text: 'made-up leaf' }))).toBe(false);
    // The theme options come from the stored sets alone.
    expect(themeOptions([queuedSet])).toEqual([]);
  });

  it('[ITEM-17] counts each option as if chosen alone in its filter, the other filters as they are, queued items included, 0 kept', () => {
    const counts = optionCounts(all, q({ kind: ['SET'] }), themes);
    expect(Object.fromEntries(counts.condition)).toEqual({ SEALED: 1, USED_WITH_BOX: 3, USED_NO_BOX: 1 });
    expect(Object.fromEntries(counts.complete)).toEqual({ yes: 3, no: 2, 'not-recorded': 0 });
    // The kind filter's own counts ignore its own choice.
    expect(Object.fromEntries(counts.kind)).toEqual({ SET: 5, MINIFIG: 1, BULK: 1, OTHER: 0 });
    // The queued set counts under every theme.
    expect(Object.fromEntries(counts.theme)).toEqual({ 'Made-up Ninjas': 3, 'Made-up Pirates': 2, [UNKNOWN_THEME]: 2 });
    expect(Object.fromEntries(counts.attention)).toEqual({ 'no-value': 2, 'incomplete-unnoted': 1 });
  });

  it('[ITEM-17] the counts of condition, completeness, instructions and kind each add up to what the list shows without that filter', () => {
    for (const query of [DEFAULT_QUERY, q({ theme: ['Made-up Ninjas'] }), q({ attention: ['no-value'], text: 'made-up' }), q({ complete: ['no'], kind: ['SET', 'BULK'] })]) {
      const counts = optionCounts(all, query, themes);
      for (const key of ['condition', 'complete', 'instructions', 'kind'] as const) {
        const sum = [...counts[key].values()].reduce((a, b) => a + b, 0);
        expect(sum, `${key} of ${JSON.stringify(query)}`).toBe(all.filter((one) => matchesQuery(one, query, key)).length);
      }
    }
  });
});

describe('the item list’s sort', () => {
  const stored = [
    { id: 'a', year: 2001, value: { amount: 10 } },
    { id: 'b', year: null, value: null },
    { id: 'c', year: 2019, value: { amount: 250 } },
    { id: 'd', year: 2019, value: undefined },
    { id: 'e', year: null, value: { amount: 10 } },
  ];

  it('[ITEM-16] sorts by date added as listed, by value highest first, by year newest first, those without one last in added order', () => {
    expect(sortItems(stored, 'added').map((one) => one.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sortItems(stored, 'value').map((one) => one.id)).toEqual(['c', 'a', 'e', 'b', 'd']);
    expect(sortItems(stored, 'year').map((one) => one.id)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });
});

describe('the item list’s query string', () => {
  it('[ITEM-18] writes nothing for the default list, and reads back what it writes', () => {
    expect(listQueryString(DEFAULT_QUERY)).toBe('');
    expect(listQueryString(q({ text: '  ' }))).toBe('');
    const query = q({ text: 'dojo', theme: ['Made-up Ninjas', UNKNOWN_THEME], condition: ['USED_NO_BOX'], complete: ['not-recorded'], instructions: ['no'], kind: ['SET', 'BULK'], attention: ['incomplete-unnoted'], sort: 'value' });
    const search = listQueryString(query);
    expect(search).toBe('?q=dojo&theme=Made-up+Ninjas&theme=&condition=used-no-box&complete=not-recorded&instructions=no&kind=set&kind=bulk&attention=incomplete-unnoted&sort=value');
    expect(parseListQuery(search, themes)).toEqual(query);
  });

  it('[ITEM-18] ignores an unknown or malformed value, never failing', () => {
    expect(parseListQuery('', themes)).toEqual(DEFAULT_QUERY);
    expect(parseListQuery('?theme=Made-up+Space&condition=MINT&condition=sealed&complete=maybe&kind=SET&kind=minifig&sort=price&sort=year&x=1&%E0%A4%A', themes)).toEqual(q({ condition: ['SEALED'], kind: ['MINIFIG'] }));
    expect(parseListQuery('sort=added', themes)).toEqual(DEFAULT_QUERY);
    expect(parseListQuery(`q=${'x'.repeat(500)}`, themes).text).toHaveLength(100);
    // Theme not known only while a listed set has no theme.
    expect(parseListQuery('theme=', ['Made-up Pirates']).theme).toEqual([]);
  });

  it('[ITEM-18] keeps chosen options in the page’s order, once each', () => {
    let query = toggleOption(DEFAULT_QUERY, 'condition', 'USED_NO_BOX', themes);
    query = toggleOption(query, 'condition', 'SEALED', themes);
    expect(query.condition).toEqual(['SEALED', 'USED_NO_BOX']);
    expect(toggleOption(query, 'condition', 'SEALED', themes).condition).toEqual(['USED_NO_BOX']);
    expect(parseListQuery('kind=bulk&kind=set&kind=bulk', themes).kind).toEqual(['SET', 'BULK']);
  });
});
