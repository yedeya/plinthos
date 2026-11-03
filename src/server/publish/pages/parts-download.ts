/**
 * Selling mode's parts download ([PUB-20], #5): `parts.csv` and `parts.xml`, rendered from the
 * lots the data holds, which the projection reads from the stored `parts_lot` rows, never from the
 * uploaded file. Each line holds the lot's item type, item number, colour, condition and
 * quantity, and its unit price only when the data holds one, which it does only while market
 * values are shown. There is no remark, comment or any other field: the data has none.
 *
 * `parts.xml` is BrickLink's inventory XML, the form BrickStore opens and BrickLink's upload
 * takes: `<INVENTORY>` of `<ITEM>`s with `<ITEMTYPE>`, `<ITEMID>`, `<COLOR>`, `<QTY>`,
 * `<CONDITION>` and `<PRICE>` (`src/server/parts/parse.ts` reads the same tags). Every value is
 * escaped. `parts.csv` quotes a cell that needs it, and starts a cell that a spreadsheet would
 * read as a formula with an apostrophe.
 */
import type { PublicCatalogueData, PublicLot } from '../catalogue-data';
import { catalogueMessages as m } from './messages';
import { currencyOf, isAmount } from './values';

/** The lots the data holds, or none. */
function lotsOf(data: PublicCatalogueData): readonly PublicLot[] {
  return Array.isArray(data.parts?.list) ? (data.parts?.list ?? []) : [];
}

/** A lot's unit price, when the data holds one and a currency for it. */
function priceOf(data: PublicCatalogueData, lot: PublicLot): number | null {
  return currencyOf(data) !== null && isAmount(lot.price) ? lot.price : null;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function xmlText(value: string | number): string {
  // A character XML 1.0 can't hold is dropped, so the file always parses.
  // eslint-disable-next-line no-control-regex -- the point is to drop control characters
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  return text.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/** BrickLink's inventory XML of the lots. */
export function renderPartsXml(data: PublicCatalogueData): string {
  const items = lotsOf(data).map((lot) => {
    const price = priceOf(data, lot);
    return [
      '<ITEM>',
      `<ITEMTYPE>${xmlText(lot.type)}</ITEMTYPE>`,
      `<ITEMID>${xmlText(lot.no)}</ITEMID>`,
      `<COLOR>${xmlText(lot.color)}</COLOR>`,
      `<QTY>${xmlText(lot.quantity)}</QTY>`,
      `<CONDITION>${lot.condition === 'U' ? 'U' : 'N'}</CONDITION>`,
      ...(price === null ? [] : [`<PRICE>${xmlText(price)}</PRICE>`]),
      '</ITEM>',
    ].join('');
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n${items.map((item) => `${item}\n`).join('')}</INVENTORY>\n`;
}

/** One CSV cell: quoted when it holds a quote, a comma or a line break; never read as a formula. */
function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The lots as CSV, with a header line, and a price column only when a lot has a price. */
export function renderPartsCsv(data: PublicCatalogueData): string {
  const lots = lotsOf(data);
  const currency = currencyOf(data);
  const priced = currency !== null && lots.some((lot) => priceOf(data, lot) !== null);
  const header = [...m.download.columns, ...(priced && currency !== null ? [m.download.price(currency)] : [])];
  const rows = lots.map((lot) => {
    const price = priceOf(data, lot);
    return [lot.type, lot.no, lot.color, lot.condition === 'U' ? 'U' : 'N', lot.quantity, ...(priced ? [price === null ? '' : price] : [])];
  });
  return [header, ...rows].map((row) => `${row.map(csvCell).join(',')}\r\n`).join('');
}
