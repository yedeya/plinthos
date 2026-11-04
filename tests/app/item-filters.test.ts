import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  DEFAULT_VIEW,
  listedSubject,
  matchesView,
  NO_FILTERS,
  optionCounts,
  queuedSubject,
  readView,
  sortListed,
  THEME_UNKNOWN,
  themeOptions,
  viewQuery,
  type FilterName,
  type FilterSubject,
  type ListFilters,
} from '../../src/app/_admin/item-filters';
import { queuedItems, type ListedItem, type QueuedItem } from '../../src/app/_offline/items';
import type { QueuedEntry } from '../../src/app/_offline/queue';

/**
 * The filters, counts, sort and query string of the item list on `/admin` (brief #251, Issue C),
 * as pure functions over what the page loaded. Every set, theme and value is made up.
 */

function listed(overrides: Partial<ListedItem> & Pick<ListedItem, 'name'>): ListedItem {
  return {
    id: randomUUID(),
    kind: 'SET',
    setNum: null,
    refNo: null,
    condition: 'SEALED',
    quantity: 1,
    stockImageUrl: null,
    coverThumbnailUrl: null,
    version: 1,
    theme: null,
    topTheme: null,
    year: null,
    complete: true,
    hasInstructions: true,
    hasMissingNotes: false,
    value: null,
    ...overrides,
  };
}

const value = (amount: number) => ({ amount, currency: 'EUR', source: 'override' as const, asOf: null });

// Newest added first, as `listItems` answers them.
const ship = listed({ setNum: '99001-1', name: 'Made-up galleon', theme: 'Made-up Pirates II', topTheme: 'Made-up Pirates', year: 2015, condition: 'SEALED', value: value(120) });
const dojo = listed({ setNum: '99002-1', name: 'Made-up dojo', theme: 'Made-up Spinners', topTheme: 'Made-up Ninjas', year: 2021, condition: 'USED_WITH_BOX', complete: false, hasMissingNotes: false, value: value(40) });
const temple = listed({ setNum: '99003-1', name: 'Made-up temple', theme: 'Made-up Ninjas', topTheme: 'Made-up Ninjas', year: 2012, condition: 'USED_NO_BOX', complete: false, hasMissingNotes: true, hasInstructions: false });
const unknownTheme = listed({ setNum: '99004-1', name: 'Made-up fort', theme: 'Made-up Forts', topTheme: null, year: 2019, condition: 'USED_WITH_BOX', value: value(15) });
const figure = listed({ kind: 'MINIFIG', name: 'Made-up captain', refNo: 'mu0007', condition: 'USED_NO_BOX', complete: null, hasInstructions: null, value: value(500) });
const bulk = listed({ kind: 'BULK', name: 'Made-up mixed bricks', condition: 'USED_NO_BOX', complete: false, hasInstructions: null });
const stored = [ship, dojo, temple, unknownTheme, figure, bulk];
const themes = themeOptions(stored);

const queuedSet: QueuedItem = { id: randomUUID(), kind: 'SET', setNum: '99009-1', name: null, refNo: null, condition: 'SEALED', quantity: 1, complete: true, hasInstructions: false, hasMissingNotes: false, created: true, deleted: false, held: false, photos: 0 };
const queuedOther: QueuedItem = { ...queuedSet, id: randomUUID(), kind: 'OTHER', setNum: null, name: 'Made-up keychain', complete: null, hasInstructions: null };

const subjects: FilterSubject[] = [...[queuedSet, queuedOther].map(queuedSubject), ...stored.map(listedSubject)];

function shown(filters: Partial<ListFilters>): string[] {
  const all = { ...NO_FILTERS, ...filters };
  return subjects.filter((subject) => matchesView(subject, all)).map((subject) => subject.name ?? subject.setNum ?? '');
}

describe('the filters', () => {
  it('[ITEM-14] offers the listed sets’ top-level themes by name, and Theme not known for a set without one', () => {
    expect(themes).toEqual(['Made-up Ninjas', 'Made-up Pirates', THEME_UNKNOWN]);
    expect(themeOptions([ship, dojo])).toEqual(['Made-up Ninjas', 'Made-up Pirates']);
  });

  it('[ITEM-14] a theme lists every set under its top-level theme, sub-themes included, and a non-set matches no theme option', () => {
    expect(shown({ theme: ['Made-up Ninjas'] })).toEqual(['99009-1', 'Made-up dojo', 'Made-up temple']);
    expect(shown({ theme: [THEME_UNKNOWN] })).toEqual(['99009-1', 'Made-up fort']);
    expect(shown({ theme: ['Made-up Pirates', THEME_UNKNOWN] })).toEqual(['99009-1', 'Made-up galleon', 'Made-up fort']);
  });

  it('[ITEM-14] filters by condition, completeness, instructions and kind, any chosen option within a filter and every filter together', () => {
    expect(shown({ condition: ['USED_WITH_BOX'] })).toEqual(['Made-up dojo', 'Made-up fort']);
    expect(shown({ condition: ['SEALED', 'USED_WITH_BOX'] })).toEqual(['99009-1', 'Made-up keychain', 'Made-up galleon', 'Made-up dojo', 'Made-up fort']);
    expect(shown({ kind: ['MINIFIG', 'BULK'] })).toEqual(['Made-up captain', 'Made-up mixed bricks']);
    expect(shown({ complete: ['no'] })).toEqual(['Made-up dojo', 'Made-up temple', 'Made-up mixed bricks']);
    expect(shown({ instructions: ['no'] })).toEqual(['99009-1', 'Made-up temple']);
    expect(shown({ complete: ['no'], condition: ['USED_NO_BOX'] })).toEqual(['Made-up temple', 'Made-up mixed bricks']);
  });

  it('[ITEM-14] each filter’s not recorded matches an item whose value in that field is null, whatever its other field holds', () => {
    // The bulk lot states its completeness but not its instructions.
    expect(shown({ complete: ['unknown'] })).toEqual(['Made-up keychain', 'Made-up captain']);
    expect(shown({ instructions: ['unknown'] })).toEqual(['Made-up keychain', 'Made-up captain', 'Made-up mixed bricks']);
  });

  it('[ITEM-14] [ITEM-8] the text filter matches the set number, the name, the reference number, the theme and the top-level theme, with the other filters', () => {
    expect(shown({ text: 'spinners' })).toEqual(['Made-up dojo']);
    expect(shown({ text: 'made-up ninjas' })).toEqual(['Made-up dojo', 'Made-up temple']);
    expect(shown({ text: 'MU0007' })).toEqual(['Made-up captain']);
    expect(shown({ text: '99003' })).toEqual(['Made-up temple']);
    expect(shown({ text: 'temple', condition: ['SEALED'] })).toEqual([]);
  });

  it('[ITEM-15] needs attention: no value, and incomplete with nothing noted', () => {
    expect(shown({ attention: ['no-value'] })).toEqual(['99009-1', 'Made-up keychain', 'Made-up temple', 'Made-up mixed bricks']);
    expect(shown({ attention: ['incomplete-unnoted'] })).toEqual(['Made-up dojo', 'Made-up mixed bricks']);
    expect(shown({ attention: ['no-value', 'incomplete-unnoted'] })).toEqual(['99009-1', 'Made-up keychain', 'Made-up dojo', 'Made-up temple', 'Made-up mixed bricks']);
  });

  it('[ITEM-19] a queued set matches every theme option, and every other filter applies to a queued item on the fields it holds', () => {
    for (const theme of themes) expect(shown({ theme: [theme] })).toContain('99009-1');
    expect(shown({ theme: themes })).not.toContain('Made-up keychain');
    expect(shown({ condition: ['USED_NO_BOX'] })).not.toContain('99009-1');
    expect(shown({ instructions: ['no'] })).toContain('99009-1');
    expect(shown({ kind: ['OTHER'] })).toEqual(['Made-up keychain']);
    expect(shown({ text: 'keychain' })).toEqual(['Made-up keychain']);
    // A queued new item has no value.
    expect(shown({ attention: ['no-value'] })).toEqual(expect.arrayContaining(['99009-1', 'Made-up keychain']));
  });

  it('[ITEM-19] the queue holds a new item’s completeness, instructions and whether a note of what is missing exists', () => {
    const id = randomUUID();
    const entries = [
      { seq: 1, name: 'saveItem', input: { id, kind: 'BULK', name: 'Made-up tub', refNo: 'mu-tub', condition: 'USED_NO_BOX', quantity: 1, baseVersion: null, complete: false, hasInstructions: null } },
      { seq: 2, name: 'saveItem', input: { id: randomUUID(), setNum: '99010-1', condition: 'SEALED', quantity: 1, baseVersion: null, complete: false, missingNotes: 'made-up arm', hasInstructions: true } },
    ] as unknown as QueuedEntry[];
    const [noted, tub] = queuedItems(entries);
    expect(tub).toMatchObject({ kind: 'BULK', refNo: 'mu-tub', complete: false, hasInstructions: null, hasMissingNotes: false });
    expect(noted).toMatchObject({ kind: 'SET', complete: false, hasInstructions: true, hasMissingNotes: true });
    expect(matchesView(queuedSubject(tub as QueuedItem), { ...NO_FILTERS, attention: ['incomplete-unnoted'] })).toBe(true);
    expect(matchesView(queuedSubject(noted as QueuedItem), { ...NO_FILTERS, attention: ['incomplete-unnoted'] })).toBe(false);
  });
});

describe('the counts', () => {
  const counts = (filters: Partial<ListFilters>) => optionCounts(subjects, { ...NO_FILTERS, ...filters }, themes);

  it('[ITEM-17] each option counts what the list would show with it chosen alone in its filter and every other filter as it is', () => {
    const withCondition = counts({ condition: ['SEALED'] });
    // The condition's own options ignore its choice; the others count under it.
    expect(withCondition.condition).toEqual(new Map([['SEALED', 3], ['USED_WITH_BOX', 2], ['USED_NO_BOX', 3]]));
    expect(withCondition.kind).toEqual(new Map([['SET', 2], ['MINIFIG', 0], ['BULK', 0], ['OTHER', 1]]));
    expect(withCondition.theme).toEqual(new Map([['Made-up Ninjas', 1], ['Made-up Pirates', 2], [THEME_UNKNOWN, 1]]));
    expect(withCondition.attention).toEqual(new Map([['no-value', 2], ['incomplete-unnoted', 0]]));
    for (const [filter, options] of Object.entries(counts({ text: 'made-up dojo' }))) {
      for (const [option, count] of options) expect(count, `${filter} ${option}`).toBe(shown({ text: 'made-up dojo', [filter]: [option] }).length);
    }
  });

  it('[ITEM-17] counts items, not their quantities, and each of the condition, completeness, instructions and kind filters adds up to the list without it', () => {
    const many = [...subjects, listedSubject(listed({ setNum: '99005-1', name: 'Made-up crate', quantity: 7, condition: 'USED_NO_BOX' }))];
    const filters: ListFilters = { ...NO_FILTERS, attention: ['no-value'] };
    const all = optionCounts(many, filters, themes);
    for (const filter of ['condition', 'complete', 'instructions', 'kind'] as const satisfies readonly FilterName[]) {
      const without = many.filter((subject) => matchesView(subject, { ...filters, [filter]: [] })).length;
      expect([...all[filter].values()].reduce((sum, count) => sum + count, 0), filter).toBe(without);
    }
    expect(all.condition.get('USED_NO_BOX')).toBe(3);
  });

  it('[ITEM-17] [ITEM-19] an option that would show none is still offered with 0, and the counts include queued items', () => {
    const none = counts({ text: 'nothing-like-it' });
    expect([...none.condition.keys()]).toEqual(['SEALED', 'USED_WITH_BOX', 'USED_NO_BOX']);
    expect([...none.complete.values()]).toEqual([0, 0, 0]);
    expect([...none.theme.keys()]).toEqual(themes);
    const everything = counts({});
    expect(everything.kind.get('OTHER')).toBe(1);
    expect(everything.theme.get('Made-up Pirates')).toBe(2);
  });
});

describe('the sort', () => {
  const names = (items: readonly ListedItem[]) => items.map((item) => item.name);

  it('[ITEM-16] sorts by date added, newest first, by default', () => {
    expect(names(sortListed(stored, 'added'))).toEqual(names(stored));
  });

  it('[ITEM-16] sorts by value, highest first, with every item without one after, newest added first among them', () => {
    expect(names(sortListed(stored, 'value'))).toEqual(['Made-up captain', 'Made-up galleon', 'Made-up dojo', 'Made-up fort', 'Made-up temple', 'Made-up mixed bricks']);
  });

  it('[ITEM-16] sorts by year, newest first, with every non-set after, newest added first among them', () => {
    expect(names(sortListed(stored, 'year'))).toEqual(['Made-up dojo', 'Made-up fort', 'Made-up galleon', 'Made-up temple', 'Made-up captain', 'Made-up mixed bricks']);
  });
});

describe('the query string', () => {
  const view = {
    filters: { ...NO_FILTERS, text: 'made-up', theme: ['Made-up Pirates', THEME_UNKNOWN], condition: ['SEALED', 'USED_WITH_BOX'], complete: ['unknown'], instructions: ['no'], kind: ['BULK'], attention: ['no-value'] },
    sort: 'value',
  } as const;

  it('[ITEM-18] the default list has no query string', () => {
    expect(viewQuery(DEFAULT_VIEW)).toBe('');
    expect(readView({}, themes)).toEqual(DEFAULT_VIEW);
    expect(viewQuery(readView({ sort: 'added' }, themes))).toBe('');
  });

  it('[ITEM-18] keeps the filters, the text filter and the sort, and reads back the same view', () => {
    const query = viewQuery(view);
    expect(query).not.toBe('');
    const back = readView(new URLSearchParams(query), themes);
    expect(back.sort).toBe('value');
    expect(back.filters).toEqual(view.filters);
    expect(viewQuery(back)).toBe(query);
    // As the page receives it: a repeated name is an array.
    const record: Record<string, string[]> = {};
    for (const [name, text] of new URLSearchParams(query)) (record[name] ??= []).push(text);
    expect(readView(record, themes)).toEqual(back);
  });

  it('[ITEM-18] ignores an unknown or malformed value, never failing', () => {
    const read = readView({ theme: ['Made-up Pirates', 'Not a listed theme'], condition: ['sealed', 'MINT'], complete: 'maybe', kind: ['set', 'set'], attention: 'everything', sort: 'price', other: 'x', q: ['first', 'second'] }, themes);
    expect(read).toEqual({ filters: { ...NO_FILTERS, text: 'first', theme: ['Made-up Pirates'], condition: ['SEALED'], kind: ['SET'] }, sort: 'added' });
    expect(readView({ q: 'x'.repeat(5000) }, themes).filters.text).toHaveLength(100);
  });

  it('[ITEM-14] the Filters button counts the filters that are on', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, text: 'made-up' })).toBe(0);
    expect(activeFilterCount(view.filters)).toBe(6);
    expect(activeFilterCount({ ...NO_FILTERS, condition: ['SEALED', 'USED_NO_BOX'] })).toBe(1);
  });
});
