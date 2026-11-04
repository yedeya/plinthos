import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatalogueSummary, coverPath, printDocumentTitle } from '../../src/app/_admin/catalogue-summary';
import { en } from '../../src/app/messages/en';
import { catalogueSections, fileStamp } from '../../src/server/export/summary';
import type { PublicCatalogueData, PublicItem } from '../../src/server/publish/catalogue-data';

/**
 * The printable catalogue (#255, [EXP-5]): the summary, then every item the catalogue shows,
 * grouped by segment, each with its cover thumbnail through the admin's cover route when it has a
 * photo and no image at all when it has none; and the document title a saved PDF is named after.
 * `[PUB-4]`'s canary test renders it from the projection under every setting; these use made-up
 * data alone.
 */

function item(overrides: Partial<PublicItem> & Pick<PublicItem, 'id' | 'name'>): PublicItem {
  return {
    kind: 'SET',
    setNum: null,
    refNo: null,
    theme: null,
    year: null,
    numParts: null,
    approxParts: null,
    approxWeightG: null,
    condition: 'SEALED',
    complete: true,
    missingNotes: null,
    hasInstructions: true,
    description: '',
    quantity: 1,
    stockImageUrl: null,
    photos: [],
    ...overrides,
  };
}

const PHOTO = { full: 'p/made-up-full.webp', thumb: 'p/made-up-thumb.webp' };

const ITEMS: PublicItem[] = [
  item({ id: '00000000-0000-4000-8000-000000000001', setNum: '99901-1', name: 'Made-up Lighthouse', year: 2001, photos: [PHOTO] }),
  item({ id: '00000000-0000-4000-8000-000000000002', setNum: '99902-1', name: 'Made-up Harbour', year: 2002, condition: 'USED_WITH_BOX', complete: false, missingNotes: 'two made-up tiles', hasInstructions: false }),
  item({ id: '00000000-0000-4000-8000-000000000003', kind: 'MINIFIG', name: 'Made-up Pilot', refNo: 'mu001', condition: 'USED_NO_BOX', complete: null, hasInstructions: null, photos: [PHOTO, PHOTO] }),
  item({ id: '00000000-0000-4000-8000-000000000004', kind: 'BULK', name: 'Made-up bucket of bricks', condition: 'USED_NO_BOX', complete: null, hasInstructions: null, quantity: 3 }),
];

function data(overrides: Partial<PublicCatalogueData> = {}): PublicCatalogueData {
  return {
    format: 4,
    publishedAt: '2026-11-03T22:09:41.512Z',
    introText: 'A made-up collection.',
    contactText: 'Ask the made-up owner.',
    items: ITEMS,
    parts: { lots: 12, quantity: 345, photos: [] },
    ...overrides,
  };
}

const render = (catalogue: PublicCatalogueData) => renderToStaticMarkup(createElement(CatalogueSummary, { data: catalogue }));

describe('the printable catalogue', () => {
  it('[EXP-5] lists every item after the summary, grouped by segment as the catalogue groups them, the loose parts as a count line', () => {
    const html = render(data());
    expect(html.indexOf(en.summary.contents)).toBeLessThan(html.indexOf(en.summary.list));
    expect(html.match(/class="print-item"/g)).toHaveLength(ITEMS.length);
    for (const name of ['99901-1 Made-up Lighthouse', '99902-1 Made-up Harbour', 'Made-up Pilot', 'Made-up bucket of bricks']) expect(html).toContain(name);
    expect(catalogueSections(data()).map((section) => [section.segment, section.items.map((one) => one.id), section.parts])).toEqual([
      ['sealed', [ITEMS[0]?.id], null],
      ['used', [ITEMS[1]?.id, ITEMS[2]?.id], null],
      ['parts', [ITEMS[3]?.id], { lots: 12, quantity: 345 }],
    ]);
    const list = html.slice(html.indexOf(en.summary.list));
    expect(list.indexOf('Made-up Lighthouse')).toBeLessThan(list.indexOf('Made-up Harbour'));
    expect(list.indexOf('Made-up Pilot')).toBeLessThan(list.indexOf('Made-up bucket of bricks'));
    expect(list).toContain(en.summary.parts(12, 345));
  });

  it('[EXP-5] gives each row its public facts: year, condition, complete, instructions, and the quantity when more than one', () => {
    const html = render(data());
    expect(html).toContain(['2001', en.condition.SEALED, en.summary.complete, en.summary.instructions].join(' · '));
    expect(html).toContain(['2002', en.condition.USED_WITH_BOX, en.summary.missing('two made-up tiles'), en.summary.noInstructions].join(' · '));
    expect(html).toContain([en.items.kind.MINIFIG, 'mu001', en.condition.USED_NO_BOX].join(' · '));
    expect(html).toContain(en.summary.quantity(3));
  });

  it('[EXP-5] shows an item’s cover through the admin’s cover route, eagerly, and no image at all for an item without a photo', () => {
    const html = render(data());
    const images = [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
    expect(images).toHaveLength(2);
    expect(images.map((tag) => /src="([^"]*)"/.exec(tag)?.[1])).toEqual([coverPath(ITEMS[0]?.id ?? ''), coverPath(ITEMS[2]?.id ?? '')]);
    for (const tag of images) {
      expect(tag).toContain('loading="eager"');
      expect(tag).not.toContain('lazy');
    }
    // Neither of the data's photo paths, which no file is written under.
    expect(html).not.toContain(PHOTO.thumb);
    expect(html).not.toContain(PHOTO.full);
    // The rows without a photo have no image box either.
    const harbour = html.slice(html.lastIndexOf('<li', html.indexOf('99902-1 Made-up Harbour')), html.indexOf('99902-1 Made-up Harbour'));
    expect(harbour).not.toContain('print-item__photo');
    expect(render(data({ items: [ITEMS[1] as PublicItem, ITEMS[3] as PublicItem] }))).not.toContain('<img');
  });

  it('[EXP-5] shows an item’s value only where the data holds one', () => {
    expect(render(data())).not.toContain('print-item__value');
    const valued = render(data({ valueCurrency: 'EUR', items: ITEMS.map((one, index) => (index === 0 ? { ...one, value: 123.5, asOf: '2026-11-01' } : one)) }));
    expect(valued.match(/print-item__value/g)).toHaveLength(1);
    expect(valued).toContain(en.summary.money(123.5, 'EUR'));
  });

  it('[EXP-5] says the catalogue holds nothing, and lists no item, when it is empty', () => {
    const html = render(data({ items: [], parts: null }));
    expect(html).toContain(en.summary.empty);
    expect(html).not.toContain(en.summary.list);
  });
});

describe('the printable catalogue’s document title', () => {
  it('[EXP-5] names the catalogue, says it is the catalogue and when it was made, in UTC, with no colon or slash', () => {
    expect(fileStamp('2026-11-03T22:09:41.512Z')).toBe('2026-11-03 22.09');
    expect(fileStamp('2026-01-02T03:04:00+01:00')).toBe('2026-01-02 02.04');
    expect(printDocumentTitle('2026-11-03T22:09:41.512Z')).toBe('Plinthos – catalogue – 2026-11-03 22.09');
    expect(printDocumentTitle('2026-11-03T22:09:41.512Z', 'Made-up: bricks/plates')).toBe('Made-up bricks plates – catalogue – 2026-11-03 22.09');
    expect(printDocumentTitle('2026-11-03T22:09:41.512Z', '  ')).toBe('Plinthos – catalogue – 2026-11-03 22.09');
    expect(printDocumentTitle('2026-11-03T22:09:41.512Z', 'a\\b*c?d"e<f>g|h')).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('[EXP-5] is set by the page, which exports no generateMetadata', async () => {
    const { readRepoFile } = await import('../support/repo-file');
    const page = readRepoFile('src/app/admin/summary/page.tsx');
    expect(page).toContain('<DocumentTitle title={printDocumentTitle(data.publishedAt)} />');
    expect(page).not.toContain('generateMetadata');
  });
});
