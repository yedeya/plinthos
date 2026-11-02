import { describe, expect, it } from 'vitest';
import type { PublicCatalogueData, PublicItem } from '../../../../src/server/publish/catalogue-data';
import { renderCataloguePages, renderLanding, renderPartsPage, renderSetPage } from '../../../../src/server/publish/pages';
import { escapeHtml, UnsafeCatalogueDataError } from '../../../../src/server/publish/pages/html';
import { catalogue, item, items, STOCK } from './fixture';

/**
 * `[PUB-10]` to `[PUB-12]` and `[PUB-14]`: the public catalogue's pages, rendered from a made-up
 * `PublicCatalogueData` alone (`docs/design/catalogue.md`). Each page has `noindex`, links only
 * relatively so it works under any token, escapes every text, and shows nothing outside the
 * contract.
 */

const pageAt = (data: PublicCatalogueData, path: string): string => {
  const page = renderCataloguePages(data).find((p) => p.path === path);
  if (page === undefined) throw new Error(`no page at ${path}`);
  return page.body;
};

/** The grid's cards, in document order, as their set numbers. */
const cardOrder = (body: string): string[] => [...body.matchAll(/<li class="card"[^>]*data-set-num="([^"]+)"/g)].map((match) => match[1] ?? '');

const htmlPages = (data: PublicCatalogueData) => renderCataloguePages(data).filter((page) => page.contentType.startsWith('text/html'));

describe('the catalogue’s files', () => {
  it('[PUB-10] [PUB-12] [PUB-14] are the landing, a page per item, the parts page and the two assets, all relative to the snapshot’s root', () => {
    expect(renderCataloguePages(catalogue()).map((page) => page.path)).toEqual([
      'index.html',
      's/item-a/index.html',
      's/item-b/index.html',
      's/item-c/index.html',
      's/item-d/index.html',
      'parts/index.html',
      'assets/catalogue.css',
      'assets/catalogue.js',
    ]);
    expect(renderCataloguePages(catalogue({ parts: null })).map((page) => page.path)).not.toContain('parts/index.html');
  });

  it('[PUB-11] [PUB-12] every page has noindex, no referrer, a strict policy, and only relative links, never a token or an absolute path into the snapshot', () => {
    for (const page of htmlPages(catalogue())) {
      expect(page.body, page.path).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(page.body, page.path).toContain('<meta name="referrer" content="no-referrer">');
      expect(page.body, page.path).toContain('script-src &#39;self&#39;');
      expect(page.body, page.path).not.toMatch(/(?:href|src)="\/(?!\/)/);
      expect(page.body, page.path).not.toMatch(/\/c\//);
      for (const [, url] of page.body.matchAll(/(?:href|src)="([^"]+)"/g)) {
        expect(url === STOCK || !/^[a-z]+:/i.test(url ?? ''), `${page.path} ${url}`).toBe(true);
      }
    }
    expect(pageAt(catalogue(), 's/item-a/index.html')).toContain('href="../../assets/catalogue.css"');
    expect(pageAt(catalogue(), 's/item-a/index.html')).toContain('src="../../p/made-up-full-a1.webp"');
    expect(pageAt(catalogue(), 'parts/index.html')).toContain('src="../p/made-up-full-parts1.webp"');
    expect(pageAt(catalogue(), 'index.html')).toContain('href="s/item-b/index.html"');
  });

  it('[PUB-11] [PUB-12] [PUB-14] every image has alt text, and the thumbnails load lazily', () => {
    for (const page of htmlPages(catalogue())) {
      for (const [img] of page.body.matchAll(/<img [^>]*>/g)) expect(img, page.path).toMatch(/ alt="[^"]+"/);
    }
    const landing = pageAt(catalogue(), 'index.html');
    for (const [img] of landing.matchAll(/<img [^>]*>/g)) expect(img).toContain('loading="lazy"');
    const set = pageAt(catalogue(), 's/item-b/index.html');
    const slides = [...set.matchAll(/<li class="gallery__slide"[^>]*>.*?<img ([^>]*)>/g)].map((match) => match[1] ?? '');
    expect(slides).toHaveLength(4);
    expect(slides[0]).not.toContain('loading="lazy"');
    for (const slide of slides.slice(1)) expect(slide).toContain('loading="lazy"');
  });
});

describe('the landing', () => {
  it('[PUB-10] shows the intro, the contact text, and the summary counted from the data: sets per condition, items with quantities, and the loose parts', () => {
    const body = renderLanding(catalogue());
    expect(body).toContain('A made-up collection of sets.');
    expect(body).toContain('Write to the made-up owner.');
    expect(body).toContain('4 sets · 7 items');
    expect(body).toContain('Sealed 1 · Used, box 2 · Used, no box 1');
    expect(body).toContain('Loose parts 48,210 in 1,930 lots');
    expect(body.indexOf('A made-up collection')).toBeLessThan(body.indexOf('data-summary'));
    expect(body.indexOf('data-catalogue-grid')).toBeLessThan(body.indexOf('Write to the made-up owner.'));
  });

  it('[PUB-10] counts only what the data holds: one item less is one set less, and no parts means no parts line', () => {
    const body = renderLanding(catalogue({ items: items.slice(1), parts: null }));
    expect(body).toContain('3 sets · 5 items');
    expect(body).toContain('Sealed 1 · Used, box 2');
    expect(body).not.toContain('Used, no box 1');
    expect(body).not.toContain('Loose parts');
    expect(renderLanding(catalogue({ items: [items[1] as PublicItem], parts: null }))).toContain('1 set · 1 item');
  });

  it('[PUB-10] leaves out an empty intro and an empty contact section', () => {
    const body = renderLanding(catalogue({ introText: '  ', contactText: '' }));
    expect(body).not.toContain('About this collection');
    expect(body).not.toContain('id="contact-heading"');
  });

  it('[PUB-11] lists every item sorted by set number in natural order, with its thumbnail, number, name, theme, year and condition', () => {
    const shuffled = catalogue({ items: [items[2], items[0], items[3], items[1]] as PublicItem[] });
    const body = renderLanding(shuffled);
    expect(cardOrder(body)).toEqual(['7140-1', '10294-1', '21318-1', '60000-1']);
    expect(body).toContain('<span class="card__num">10294-1</span>');
    expect(body).toContain('<span class="card__name">Made-up Liner</span>');
    expect(body).toContain('Made-up Icons · 2021');
    expect(body).toContain('data-condition="USED_NO_BOX"');
    expect(body).toMatch(/<span class="chip[^"]*">Used, no box<\/span>/);
  });

  it('[PUB-11] shows the stock image by default, the owner’s cover thumbnail when there is none, and a tile with neither', () => {
    const body = renderLanding(catalogue());
    const card = (setNum: string) => body.slice(body.indexOf(`data-set-num="${setNum}"`), body.indexOf('</li>', body.indexOf(`data-set-num="${setNum}"`)));
    expect(card('10294-1')).toContain(`src="${STOCK}"`);
    expect(card('10294-1')).not.toContain('made-up-thumb-b1');
    expect(card('21318-1')).toContain('src="p/made-up-thumb-c1.webp"');
    expect(card('60000-1')).not.toContain('<img');
    expect(card('60000-1')).toContain('No photo');
  });

  it('[PUB-11] holds the condition chips, the theme select with each theme once and the sort select, hidden until the script runs', () => {
    const body = renderLanding(catalogue());
    expect(body).toMatch(/<form class="filters" data-catalogue-filters hidden/);
    for (const value of ['', 'SEALED', 'USED_WITH_BOX', 'USED_NO_BOX']) expect(body).toContain(`<input type="radio" name="condition" value="${value}"`);
    const themes = [...body.matchAll(/<option value="([^"]*)">/g)].map((match) => match[1]);
    expect(themes).toEqual(['', 'Made-up Icons', 'Made-up Space', 'Made-up Town', 'setNum', 'year', 'name']);
    expect(body).toContain('<p class="empty" data-catalogue-empty hidden>No sets match these filters.</p>');
  });

  it('[PUB-11] says nothing is published yet when there are no items', () => {
    const body = renderLanding(catalogue({ items: [], parts: null }));
    expect(body).toContain('Nothing is published yet.');
    expect(body).not.toContain('data-catalogue-grid');
    expect(body).toContain('0 sets · 0 items');
  });

  it('[PUB-14] links the loose parts with their overview thumbnails and counts, and no value', () => {
    const body = renderLanding(catalogue());
    expect(body).toContain('href="parts/index.html"');
    expect(body).toContain('src="p/made-up-thumb-parts1.webp"');
    expect(body).toContain('48,210 parts in 1,930 lots');
  });
});

describe('a set’s page', () => {
  it('[PUB-12] shows the gallery of the owner’s photos then the stock image, and the fields [PUB-12] lists', () => {
    const body = renderSetPage(catalogue(), items[1] as PublicItem);
    expect(body).toContain('<title>10294-1 Made-up Liner</title>');
    expect(body).toContain('Made-up Icons · 2021 · 9,090 pieces');
    const slides = [...body.matchAll(/<li class="gallery__slide"[^>]*><a href="([^"]+)"/g)].map((match) => match[1]);
    expect(slides).toEqual(['../../p/made-up-full-b1.webp', '../../p/made-up-full-b2.webp', '../../p/made-up-full-b3.webp', STOCK]);
    expect(body).toContain('href="#photo-4"');
    expect(body).toContain('<dt>Condition</dt><dd>Sealed</dd>');
    expect(body).toContain('<dt>Complete</dt><dd>Yes</dd>');
    expect(body).not.toContain('What&#39;s missing');
    expect(body).toContain('<dt>Instructions</dt><dd>Yes</dd>');
    expect(body).toContain('<dt>Quantity</dt><dd>1</dd>');
    expect(body).toContain('Made-up description.\nSecond line.');
    expect(body).toContain('href="../../index.html"');
  });

  it('[PUB-12] says what is missing after Complete when the set is not complete', () => {
    const body = renderSetPage(catalogue(), items[0] as PublicItem);
    expect(body).toContain('<dt>Complete</dt><dd>No</dd>');
    expect(body.indexOf('What&#39;s missing')).toBeGreaterThan(body.indexOf('<dt>Complete</dt>'));
    expect(body).toContain('Two made-up grey plates');
    expect(body).toContain('<dt>Instructions</dt><dd>No</dd>');
    expect(body).toContain('<dt>Quantity</dt><dd>2</dd>');
  });

  it('[PUB-12] says there are no photos when the set has neither photos nor a stock image', () => {
    const body = renderSetPage(catalogue(), items[3] as PublicItem);
    expect(body).toContain('No photos yet.');
    expect(body).not.toContain('<img');
  });

  it('[PUB-12] leaves out a stock image that is not https://, and refuses a photo path or an id that could leave the snapshot', () => {
    const body = renderSetPage(catalogue(), item({ id: 'x', setNum: '1-1', name: 'n', stockImageUrl: 'javascript:alert(1)' }));
    expect(body).not.toContain('javascript:');
    for (const bad of ['../secret.webp', '/p/x.webp', 'https://evil.test/x.webp', 'p//x.webp']) {
      expect(() => renderSetPage(catalogue(), item({ id: 'x', setNum: '1-1', name: 'n', photos: [{ full: bad, thumb: bad }] })), bad).toThrow(UnsafeCatalogueDataError);
    }
    for (const id of ['../x', 'a/b', '', 'a b']) {
      expect(() => renderCataloguePages(catalogue({ items: [item({ id, setNum: '1-1', name: 'n' })] })), id).toThrow(UnsafeCatalogueDataError);
    }
  });
});

describe('the parts page', () => {
  it('[PUB-14] shows the lots, the loose parts and the overview photos, and no price, value or lot list', () => {
    const data = catalogue();
    const body = renderPartsPage(data, data.parts as NonNullable<PublicCatalogueData['parts']>);
    expect(body).toContain('48,210 parts in 1,930 lots');
    expect(body).toContain('src="../p/made-up-full-parts1.webp"');
    expect(body).toContain('alt="Loose parts, photo 2 of 2"');
    expect(body).not.toMatch(/price|value|€|\$|lot list/i);
  });

  it('[PUB-14] says there are no photos when the parts lot has none', () => {
    const body = renderPartsPage(catalogue(), { lots: 1, quantity: 1, photos: [] });
    expect(body).toContain('1 part in 1 lot');
    expect(body).toContain('No photos yet.');
  });
});

describe('the escaping', () => {
  const evil = `<script>alert("x")</script>'&"\`<img src=x onerror=alert(1)>`;

  it('[PUB-10] [PUB-11] [PUB-12] [PUB-14] turns script tags and quotes in every text field into text, never markup', () => {
    const hostile = item({ id: 'evil', setNum: `1-1${evil}`, name: `n${evil}`, theme: `t${evil}`, description: `d${evil}`, complete: false, missingNotes: `m${evil}` });
    const data = catalogue({ introText: `i${evil}`, contactText: `c${evil}`, items: [hostile] });
    for (const page of htmlPages(data)) {
      expect(page.body, page.path).not.toContain('<script>');
      expect(page.body, page.path).not.toContain('<img src=x');
      expect(page.body, page.path).not.toContain('"x")');
      // The only script element is the snapshot's own.
      expect([...page.body.matchAll(/<script/g)], page.path).toHaveLength(1);
    }
    const landing = pageAt(data, 'index.html');
    expect(landing).toContain(escapeHtml(`i${evil}`));
    expect(landing).toContain(escapeHtml(`c${evil}`));
    expect(landing).toContain(`data-theme="${escapeHtml(`t${evil}`)}"`);
    const set = pageAt(data, 's/evil/index.html');
    for (const text of [`n${evil}`, `d${evil}`, `m${evil}`]) expect(set).toContain(escapeHtml(text));
  });

  it('[PUB-10] escapes every character that could end text or an attribute', () => {
    expect(escapeHtml(`<>&"'\``)).toBe('&lt;&gt;&amp;&quot;&#39;&#96;');
  });
});

describe('the contract', () => {
  it('[PUB-10] [PUB-11] [PUB-12] [PUB-14] no page shows a field the data contract does not hold, even when one is slipped into the data', () => {
    const canary = (field: string) => `CANARY-${field}-7f3a`;
    const smuggled = ['storageLocation', 'purchasePrice', 'value', 'askingPrice', 'notes', 'createdAt', 'updatedAt', 'priceOverride', 'publicToken'];
    const extra = Object.fromEntries(smuggled.map((field) => [field, canary(field)]));
    const data = {
      ...catalogue(),
      ...extra,
      items: items.map((one) => ({ ...one, ...extra, photos: one.photos.map((photo) => ({ ...photo, ...extra })) })),
      parts: { ...(catalogue().parts as object), ...extra, lotList: [canary('lot')] },
    } as unknown as PublicCatalogueData;
    for (const page of renderCataloguePages(data)) {
      expect(page.body, page.path).not.toContain('CANARY-');
    }
  });
});
