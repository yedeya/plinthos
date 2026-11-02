/**
 * A stand-in set catalogue for the tests of the set lookup and the items (#133): the
 * `CatalogueProvider` interface over made-up sets, never Rebrickable. Every set here is invented.
 */
import { CatalogueUnavailable, type CatalogueProvider, type CatalogueSet, type CatalogueUnavailableReason } from '../../../src/server/catalogue/rebrickable';

export const MADE_UP_SETS: readonly CatalogueSet[] = [
  { setNum: '90001-1', name: 'Made-up Lighthouse', theme: 'Made-up Icons', year: 2021, numParts: 2101, imageUrl: 'https://cdn.example.test/sets/90001-1.jpg' },
  { setNum: '90002-1', name: 'Made-up Harbour', theme: 'Made-up Icons', year: 2022, numParts: 1302, imageUrl: 'https://cdn.example.test/sets/90002-1.jpg' },
  { setNum: '90003-1', name: 'Made-up Rover', theme: 'Made-up Space', year: 2019, numParts: 455, imageUrl: null },
];

export interface FakeCatalogue {
  readonly provider: CatalogueProvider;
  /** Every call, in order, as `search <query>` or `getSet <setNum>`. */
  readonly calls: string[];
  readonly budgets: number[];
  /** When set, every call fails with this reason, as the real client does. */
  failWith: CatalogueUnavailableReason | undefined;
  /** When set, every call waits for it first, so a test can hold two lookups at once. */
  gate: (() => Promise<void>) | undefined;
  /** What a search answers; every made-up set by default. */
  searchResults: readonly CatalogueSet[];
}

export function fakeCatalogue(sets: readonly CatalogueSet[] = MADE_UP_SETS): FakeCatalogue {
  const fake: FakeCatalogue = {
    calls: [],
    budgets: [],
    failWith: undefined,
    gate: undefined,
    searchResults: sets,
    provider: {
      async searchSets(query, { budgetMs }) {
        fake.calls.push(`search ${query}`);
        fake.budgets.push(budgetMs);
        await fake.gate?.();
        if (fake.failWith !== undefined) throw new CatalogueUnavailable(fake.failWith);
        return fake.searchResults.map((set) => ({ ...set }));
      },
      async getSet(setNum, { budgetMs }) {
        fake.calls.push(`getSet ${setNum}`);
        fake.budgets.push(budgetMs);
        await fake.gate?.();
        if (fake.failWith !== undefined) throw new CatalogueUnavailable(fake.failWith);
        const found = sets.find((set) => set.setNum === setNum);
        return found === undefined ? null : { ...found };
      },
    },
  };
  return fake;
}

/** A gate that opens once `count` callers have reached it. */
export function barrier(count: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    arrive() {
      arrived += 1;
      if (arrived >= count) open();
      return opened;
    },
  };
}
