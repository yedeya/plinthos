// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicCatalogueData, PublicLot } from '../../../../src/server/publish/catalogue-data';
import { renderCataloguePages, renderPartsCsv, renderPartsXml } from '../../../../src/server/publish/pages';
import { CATALOGUE_JS } from '../../../../src/server/publish/pages/catalogue-js';
import { parsePartsFile } from '../../../../src/server/parts/parse';
import { catalogue, item, items, other } from './fixture';

/**
 * `[PUB-17]` to `[PUB-20]` on the pages (#211): the renderers show a value, a total, an asking
 * price, a split view and the parts download only when the data holds them, which the projection
 * decides from the settings (`tests/server/publish/no-private-field.test.ts` holds that side).
 * Every value is made up.
 */

const pageAt = (data: PublicCatalogueData, path: string): string | undefined => renderCataloguePages(data).find((page) => page.path === path)?.body;

const lots: PublicLot[] = [
  { type: 'P', no: '3001', color: 11, condition: 'N', quantity: 4, price: 0.125 },
  { type: 'P', no: '3004', color: 5, condition: 'U', quantity: 12 },
  { type: 'M', no: 'mu0001', color: 0, condition: 'U', quantity: 1, price: 3.5 },
];

/** The fixture's items with values, in selling mode with both displays: every field the settings can add. */
function shown(overrides: Partial<PublicCatalogueData> = {}): PublicCatalogueData {
  const [a, b, c, d] = items;
  const base = catalogue();
  return catalogue({
    items: [
      { ...(a ?? item({ id: 'x', setNum: '1-1', name: 'x' })), value: 120.5, asOf: '2026-10-30', segment: 'used' },
      { ...(b ?? item({ id: 'y', setNum: '2-1', name: 'y' })), value: 1234, asOf: '2026-10-29', segment: 'sealed' },
      { ...(c ?? item({ id: 'z', setNum: '3-1', name: 'z' })), segment: 'used' },
      { ...(d ?? item({ id: 'w', setNum: '4-1', name: 'w' })), value: 9.99, asOf: '2026-10-28', segment: 'used' },
      { ...other({ id: 'item-bulk', kind: 'BULK', name: 'Made-up Mixed Bricks', approxParts: 2500 }), value: 40, asOf: '2026-11-02', segment: 'parts' },
    ],
    parts: { ...(base.parts ?? { lots: 0, quantity: 0, photos: [] }), value: 300, list: lots },
    valueCurrency: 'EUR',
    totals: { all: 1704.49, sealed: 1234, used: 130.49, parts: 340 },
    asking: { total: 1500, sealed: 1100, used: 120, parts: 280 },
    segments: ['sealed', 'used', 'parts'],
    ...overrides,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('values on the pages', () => {
  it('[PUB-17] shows each item’s value, with "estimated, as of" its day, on its card and its page, and none for an item without', () => {
    const data = shown();
    const landing = pageAt(data, 'index.html') ?? '';
    expect(landing).toContain('<span class="card__value">€1,234.00</span>');
    expect(landing).toContain('data-value="1234"');
    const page = pageAt(data, 's/item-b/index.html') ?? '';
    expect(page).toContain('Estimated value');
    expect(page).toContain('€1,234.00 <span class="muted">estimated, as of 29 October 2026</span>');
    // The tree house has no value: no line, no attribute.
    expect(pageAt(data, 's/item-c/index.html')).not.toContain('Estimated value');
    expect(landing).not.toMatch(/data-set-num="21318-1"[^>]*data-value/);
  });

  it('[PUB-17] shows the totals per segment on the landing, and sorts by value, highest first, items without one last', () => {
    const data = shown({ asking: undefined, segments: undefined });
    const landing = pageAt(data, 'index.html') ?? '';
    expect(landing).toContain('<p class="summary__values">Estimated value €1,704.49 · Sealed €1,234.00 · Used €130.49 · Loose parts €340.00</p>');
    expect(landing).toContain('<option value="value">');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(landing)?.[1] ?? '';
    new Function(CATALOGUE_JS)();
    const form = document.querySelector('[data-catalogue-filters]') as HTMLFormElement;
    (form.elements.namedItem('sort') as HTMLSelectElement).value = 'value';
    form.dispatchEvent(new Event('change', { bubbles: true }));
    const order = [...document.querySelectorAll<HTMLElement>('[data-catalogue-grid] > li')].map((card) => card.dataset.name);
    expect(order).toEqual(['Made-up Liner', 'Made-up X-wing', 'Made-up Mixed Bricks', 'Made-up Bike', 'Made-up Tree House']);
  });

  it('[PUB-17] [PUB-18] shows no value, total, asking price or value sort when the data holds none', () => {
    for (const page of renderCataloguePages(catalogue())) {
      expect(page.body, page.path).not.toMatch(/€|Estimated value|Asking price|data-value|option value="value"|parts\.csv|sealed\/index\.html/);
    }
    // A value with no currency to show it in is not shown either.
    const noCurrency = shown({ valueCurrency: undefined });
    for (const page of renderCataloguePages(noCurrency).filter((one) => one.path.endsWith('.html'))) expect(page.body, page.path).not.toMatch(/€|data-value|option value="value"/);
  });

  it('[PUB-18] shows the asking prices overall and per segment, and with asking prices alone no value sort', () => {
    const data = shown({ totals: undefined, items: catalogue().items, parts: { ...(catalogue().parts ?? { lots: 0, quantity: 0, photos: [] }), list: lots } });
    const landing = pageAt(data, 'index.html') ?? '';
    expect(landing).toContain('<p class="summary__asking">Asking price €1,500.00 · Sealed €1,100.00 · Used €120.00 · Loose parts €280.00</p>');
    expect(landing).not.toContain('Estimated value');
    expect(landing).not.toContain('<option value="value">');
  });
});

describe('the split views', () => {
  it('[PUB-19] are sealed/, used/ and parts/, each with its items and its subtotal, linked from the landing', () => {
    const data = shown();
    const landing = pageAt(data, 'index.html') ?? '';
    for (const segment of ['sealed', 'used', 'parts']) expect(landing).toContain(`href="${segment}/index.html"`);
    const sealed = pageAt(data, 'sealed/index.html') ?? '';
    expect(sealed).toContain('Made-up Liner');
    expect(sealed).not.toContain('Made-up X-wing');
    expect(sealed).toContain('<p class="summary__values" data-subtotal>Estimated value €1,234.00 · Asking price €1,100.00</p>');
    // Links climb out of the view's folder.
    expect(sealed).toContain('href="../s/item-b/index.html"');
    expect(sealed).toContain('href="../assets/catalogue.css"');
    const used = pageAt(data, 'used/index.html') ?? '';
    expect(used).toContain('Made-up X-wing');
    expect(used).toContain('Estimated value €130.49 · Asking price €120.00');
    const parts = pageAt(data, 'parts/index.html') ?? '';
    expect(parts).toContain('Estimated value €340.00 · Asking price €280.00');
    // The bulk lot is loose parts too ([VAL-7]).
    expect(parts).toContain('Made-up Mixed Bricks');
    expect(parts).toContain('href="../parts.csv"');
    expect(parts).toContain('href="../parts.xml"');
  });

  it('[PUB-19] are absent with selling mode off, and the parts page is the summary alone', () => {
    const data = shown({ segments: undefined, parts: catalogue().parts, items: catalogue().items.map((one) => ({ ...one })) });
    const paths = renderCataloguePages(data).map((page) => page.path);
    for (const path of ['sealed/index.html', 'used/index.html', 'parts.csv', 'parts.xml']) expect(paths).not.toContain(path);
    expect(pageAt(data, 'parts/index.html')).not.toMatch(/data-subtotal|parts\.csv|Bulk lots/);
  });

  it('[PUB-19] offer the parts view for bulk lots alone, with no parts imported', () => {
    const data = shown({ parts: null, segments: ['parts'] });
    const parts = pageAt(data, 'parts/index.html') ?? '';
    expect(parts).toContain('Made-up Mixed Bricks');
    expect(parts).not.toContain('data-parts-summary');
  });
});

describe('the parts download', () => {
  it('[PUB-20] is CSV with item type, number, colour, condition and quantity, and the unit price only where the data holds one', () => {
    expect(renderPartsCsv(shown())).toBe(
      'Item type,Item number,Color ID,Condition,Quantity,Unit price (EUR)\r\nP,3001,11,N,4,0.125\r\nP,3004,5,U,12,\r\nM,mu0001,0,U,1,3.5\r\n',
    );
    const unpriced = shown({ parts: { lots: 3, quantity: 17, photos: [], list: lots.map((lot) => ({ type: lot.type, no: lot.no, color: lot.color, condition: lot.condition, quantity: lot.quantity })) } });
    expect(renderPartsCsv(unpriced)).toBe('Item type,Item number,Color ID,Condition,Quantity\r\nP,3001,11,N,4\r\nP,3004,5,U,12\r\nM,mu0001,0,U,1\r\n');
  });

  it('[PUB-20] is BrickLink XML that the parts import reads back as the same lots, with prices only where held', () => {
    const xml = renderPartsXml(shown());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n')).toBe(true);
    const parsed = parsePartsFile(new TextEncoder().encode(xml));
    expect(parsed.format).toBe('BL_XML');
    expect(parsed.lots).toEqual(lots.map((lot) => ({ itemType: lot.type, itemNo: lot.no, colorId: lot.color, condition: lot.condition, quantity: lot.quantity, unitPrice: lot.price ?? null })));
    expect(xml).not.toMatch(/REMARKS|DESCRIPTION|COMMENT/);
  });

  it('[PUB-20] escapes every value, and never lets a spreadsheet read a cell as a formula', () => {
    const hostile: PublicLot[] = [{ type: 'P', no: '=HYPERLINK("x")<a>&"b",c', color: 1, condition: 'N', quantity: 1 }];
    const data = shown({ parts: { lots: 1, quantity: 1, photos: [], list: hostile } });
    expect(renderPartsCsv(data).split('\r\n')[1]).toBe(`P,"'=HYPERLINK(""x"")<a>&""b"",c",1,N,1`);
    expect(renderPartsXml(data)).toContain('<ITEMID>=HYPERLINK(&quot;x&quot;)&lt;a&gt;&amp;&quot;b&quot;,c</ITEMID>');
  });

  it('[PUB-20] holds no field the contract does not, even when one is slipped into the data', () => {
    const smuggled = lots.map((lot) => ({ ...lot, remarks: 'CANARY-remark-bin-4', comments: 'CANARY-comment', unitPrice: 'CANARY-price' }));
    const data = shown({ parts: { lots: 3, quantity: 17, photos: [], list: smuggled as PublicLot[] } });
    for (const page of renderCataloguePages(data)) expect(page.body, page.path).not.toContain('CANARY-');
  });
});
