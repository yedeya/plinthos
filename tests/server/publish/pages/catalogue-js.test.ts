// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicCatalogueData } from '../../../../src/server/publish/catalogue-data';
import { renderLanding, renderSetPage } from '../../../../src/server/publish/pages';
import { CATALOGUE_JS } from '../../../../src/server/publish/pages/catalogue-js';
import { catalogue, item, items, others } from './fixture';

/**
 * `[PUB-11]`: `assets/catalogue.js` filters and sorts the grid's cards in place, in the visitor's
 * browser, from the cards' own `data-*` attributes, with no network call. It runs here in
 * happy-dom over the landing the renderer made from made-up data.
 */

function load(page: string): void {
  const body = /<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? '';
  document.body.innerHTML = body;
  new Function(CATALOGUE_JS)();
}

const form = () => document.querySelector('[data-catalogue-filters]') as HTMLFormElement;
const visible = () => [...document.querySelectorAll<HTMLElement>('[data-catalogue-grid] > li')].filter((card) => !card.hidden).map((card) => card.dataset.setNum);
const emptyShown = () => !(document.querySelector('[data-catalogue-empty]') as HTMLElement).hidden;

function choose(name: 'theme' | 'sort' | 'kind', value: string): void {
  (form().elements.namedItem(name) as HTMLSelectElement).value = value;
  form().dispatchEvent(new Event('change', { bubbles: true }));
}

function condition(value: string): void {
  // A click, as the visitor's tap: the browser checks the radio, unchecks the others, and fires change.
  (form().querySelector(`input[name="condition"][value="${value}"]`) as HTMLInputElement).click();
}

const data: PublicCatalogueData = catalogue({
  items: [...items, item({ id: 'item-e', setNum: '6000-1', name: 'Another made-up kiosk', theme: 'Made-up Space', year: 2021, condition: 'SEALED' })],
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('the catalogue script', () => {
  it('[PUB-11] shows the filter controls and keeps the HTML’s order by set number, in natural order', () => {
    load(renderLanding(data));
    expect(form().hidden).toBe(false);
    expect(visible()).toEqual(['6000-1', '7140-1', '10294-1', '21318-1', '60000-1']);
    expect(emptyShown()).toBe(false);
  });

  it('[PUB-11] filters by condition and by theme together, and says so when nothing matches', () => {
    load(renderLanding(data));
    condition('USED_WITH_BOX');
    expect(visible()).toEqual(['21318-1', '60000-1']);
    choose('theme', 'Made-up Icons');
    expect(visible()).toEqual(['21318-1']);
    condition('SEALED');
    expect(visible()).toEqual(['10294-1']);
    choose('theme', 'Made-up Town');
    expect(visible()).toEqual([]);
    expect(emptyShown()).toBe(true);
    condition('');
    choose('theme', '');
    expect(visible()).toHaveLength(5);
    expect(emptyShown()).toBe(false);
  });

  it('[PUB-11] sorts by year, then by name, then back by set number, moving the cards in place', () => {
    load(renderLanding(data));
    choose('sort', 'year');
    expect(visible()).toEqual(['7140-1', '60000-1', '21318-1', '6000-1', '10294-1']);
    choose('sort', 'name');
    expect(visible()).toEqual(['6000-1', '60000-1', '10294-1', '21318-1', '7140-1']);
    condition('SEALED');
    expect(visible()).toEqual(['6000-1', '10294-1']);
    choose('sort', 'setNum');
    condition('');
    expect(visible()).toEqual(['6000-1', '7140-1', '10294-1', '21318-1', '60000-1']);
  });

  it('[PUB-11] makes no network call, and needs no grid on a set page, where it shows the gallery’s arrows', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    load(renderSetPage(data, items[1] as (typeof items)[number]));
    expect((document.querySelector('[data-gallery-arrows]') as HTMLElement).hidden).toBe(false);
    (document.querySelector('[data-gallery-next]') as HTMLButtonElement).click();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(CATALOGUE_JS).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|WebSocket|import\(|https?:/);
    vi.unstubAllGlobals();
  });

  it('[PUB-11] filters by kind, and sorts every item that is not a set after the sets: by name for set number, after those with a year for year', () => {
    load(renderLanding(catalogue({ items: [...others, ...items] })));
    const shown = () => [...document.querySelectorAll<HTMLElement>('[data-catalogue-grid] > li')].filter((card) => !card.hidden).map((card) => card.dataset.setNum || card.dataset.name);
    expect(shown()).toEqual(['7140-1', '10294-1', '21318-1', '60000-1', 'Made-up Captain', 'Made-up Keychain', 'Made-up Mixed Bricks']);
    choose('kind', 'BULK');
    expect(shown()).toEqual(['Made-up Mixed Bricks']);
    choose('kind', 'SET');
    expect(shown()).toEqual(['7140-1', '10294-1', '21318-1', '60000-1']);
    choose('kind', 'MINIFIG');
    condition('SEALED');
    expect(shown()).toEqual([]);
    expect(emptyShown()).toBe(true);
    condition('');
    choose('kind', '');
    choose('sort', 'year');
    expect(shown()).toEqual(['7140-1', '60000-1', '21318-1', '10294-1', 'Made-up Captain', 'Made-up Keychain', 'Made-up Mixed Bricks']);
    choose('sort', 'name');
    // Bike, Captain, Keychain, Liner, Mixed Bricks, Tree House, X-wing.
    expect(shown()).toEqual(['60000-1', 'Made-up Captain', 'Made-up Keychain', '10294-1', 'Made-up Mixed Bricks', '21318-1', '7140-1']);
    choose('sort', 'setNum');
    expect(shown()).toEqual(['7140-1', '10294-1', '21318-1', '60000-1', 'Made-up Captain', 'Made-up Keychain', 'Made-up Mixed Bricks']);
  });
});
