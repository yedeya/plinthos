/**
 * A stand-in for the set catalogue (Rebrickable, Issue A), so the set lookup and the items are
 * tested without the network. Every set here is made up: the numbers sit in a range no real set
 * uses and the names say so.
 */
import { CatalogueUnavailable, type CatalogueProvider, type CatalogueSet, type CatalogueTheme } from '../../../src/server/catalogue/rebrickable';

export function madeUpSet(setNum: string, overrides: Partial<CatalogueSet> = {}): CatalogueSet {
  return {
    setNum,
    name: `Made-up set ${setNum}`,
    theme: 'Made-up theme',
    themeId: 9901,
    topTheme: 'Made-up theme',
    year: 2001,
    numParts: 123,
    imageUrl: `https://cdn.example.test/sets/${setNum}.jpg`,
    ...overrides,
  };
}

export interface StandInCatalogue {
  readonly provider: CatalogueProvider;
  /** Every call, in order, as `<method> <argument>`. */
  readonly calls: string[];
  /** The budgets each call was given. */
  readonly budgets: number[];
  /** The sets the catalogue knows, by set number. */
  readonly sets: Map<string, CatalogueSet>;
  /** Its theme tree, as `listThemes` answers it. */
  themes: CatalogueTheme[];
  /** When set, every call throws this, as a catalogue that times out or refuses the key does. */
  failWith: CatalogueUnavailable | Error | undefined;
}

export function standInCatalogue(known: readonly CatalogueSet[] = [], themes: readonly CatalogueTheme[] = []): StandInCatalogue {
  const catalogue: StandInCatalogue = {
    calls: [],
    budgets: [],
    sets: new Map(known.map((set) => [set.setNum, set])),
    themes: [...themes],
    failWith: undefined,
    provider: {
      async searchSets(query, { budgetMs }) {
        catalogue.calls.push(`searchSets ${query}`);
        catalogue.budgets.push(budgetMs);
        if (catalogue.failWith !== undefined) throw catalogue.failWith;
        const needle = query.toLowerCase();
        return [...catalogue.sets.values()].filter((set) => set.setNum.includes(needle) || set.name.toLowerCase().includes(needle));
      },
      async getSet(setNum, { budgetMs }) {
        catalogue.calls.push(`getSet ${setNum}`);
        catalogue.budgets.push(budgetMs);
        if (catalogue.failWith !== undefined) throw catalogue.failWith;
        return catalogue.sets.get(setNum) ?? null;
      },
      async listThemes({ budgetMs }) {
        catalogue.calls.push('listThemes');
        catalogue.budgets.push(budgetMs);
        if (catalogue.failWith !== undefined) throw catalogue.failWith;
        return catalogue.themes;
      },
    },
  };
  return catalogue;
}

export { CatalogueUnavailable };
