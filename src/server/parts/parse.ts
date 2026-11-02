/**
 * The parts file parser ([PARTS-1], brief #153, Issue A): one pure function that reads a
 * BrickStore `.bsx` file or a BrickLink XML inventory export and keeps only what the inventory
 * needs of each lot.
 *
 * The two formats, as BrickStore's own source reads and writes them (`BrickStoreXML.rnc`,
 * `src/common/documentio.cpp` and `src/bricklink/io.cpp` in `rgriebl/brickstore`, read
 * 2026-11-02):
 *
 * - **`.bsx`**: `<BrickStoreXML>` (or the older `<BrickStockXML>`) holding one
 *   `<Inventory Currency="…">` of `<Item>`s, each with `<ItemID>`, `<ItemTypeID>`, `<ColorID>`,
 *   and optionally `<Qty>` (default 0), `<Price>` (default 0), `<Condition>` (`N` or `U`), and
 *   many fields this parser drops: `<Remarks>`, `<Comments>`, `<Reserved>`, `<Cost>`, the tier
 *   prices, `<Status>`, the names, the stockroom, `<DifferenceBaseValues>`, a `<GuiState>`.
 *   BrickStore writes no DOCTYPE any more, and older files carry a bare
 *   `<!DOCTYPE BrickStoreXML>`.
 * - **BrickLink XML**: `<INVENTORY>` holding `<ITEM>`s, each with `<ITEMID>`, `<ITEMTYPE>`,
 *   `<COLOR>`, `<QTY>`, `<PRICE>`, `<CONDITION>`, and dropped fields such as `<REMARKS>`,
 *   `<DESCRIPTION>` (the comments), `<MYCOST>`, `<BUYERUSERNAME>` and the stockroom.
 *
 * **It never returns a remark, a comment or any field but the six a lot keeps.** A seller keeps
 * bin locations in the remarks (#5); a field that is never read can't leak.
 *
 * **It never resolves a DTD or an entity.** The file is XML from outside, and an XML parser that
 * resolves entities can be made to read local files or fetch URLs. So a file with any
 * `<!ENTITY>`, or with a DOCTYPE other than the bare one older BrickStore files carry, is refused
 * before it is parsed; the parser then runs with entity processing off, and only the five
 * predefined XML entities and numeric character references are decoded, by hand, in the fields
 * kept. `fast-xml-parser` neither fetches nor reads anything itself.
 *
 * A price of 0 is BrickStore's "no price", so it is returned as null.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type PartsFormat = 'BSX' | 'BL_XML';
export type PartsCondition = 'N' | 'U';

export interface PartsLot {
  /** BrickLink's item type: `P` for a part, `M` a minifigure, `S` a set, and so on. */
  readonly itemType: string;
  /** BrickLink's item number, such as `3001`. */
  readonly itemNo: string;
  /** BrickLink's colour id; 0 when the item has no colour. */
  readonly colorId: number;
  readonly condition: PartsCondition;
  readonly quantity: number;
  /** The unit price in the file's currency, or null when the file has none for the lot. */
  readonly unitPrice: number | null;
}

export interface ParsedPartsFile {
  readonly format: PartsFormat;
  /** The file's currency code, such as `EUR`, when it names one. */
  readonly currency: string | null;
  readonly lots: readonly PartsLot[];
}

/** Why a file was refused: a code the page words, and a short reason for the log. */
export type RefusalCode = 'not-utf8' | 'doctype' | 'not-xml' | 'unknown-format' | 'no-lots' | 'too-many-lots' | 'invalid-lot';

/** The first lot that made the file refused: its place in the file, from 1, and its item number when it has one. */
export interface RefusedLot {
  readonly index: number;
  readonly itemNo?: string;
}

/** Thrown when a file is not one the import takes. It names the reason and the first lot it names, never a remark. */
export class PartsFileRefused extends Error {
  override name = 'PartsFileRefused';
  constructor(
    readonly code: RefusalCode,
    readonly reason: string,
    readonly lot?: RefusedLot,
  ) {
    super(lot === undefined ? reason : `lot ${lot.index}${lot.itemNo === undefined ? '' : ` (${lot.itemNo})`}: ${reason}`);
  }
}

/** The most lots one file may hold: 50,000 parts are about 2,000 lots (brief #153, §4). */
export const MAX_LOTS = 50_000;
/** The largest quantity one lot may hold. */
export const MAX_LOT_QUANTITY = 1_000_000;
/** The highest unit price a lot may name, in the file's currency. */
export const MAX_UNIT_PRICE = 1_000_000;
const MAX_ITEM_NO = 64;

/** The only DOCTYPEs a parts file may carry: the bare ones older BrickStore files wrote. */
const ALLOWED_DOCTYPE = /^<!DOCTYPE\s+(BrickStoreXML|BrickStockXML|INVENTORY)\s*>$/;

const parser = new XMLParser({
  // Off: no entity is expanded, internal or external. The predefined five are decoded by hand.
  processEntities: false,
  htmlEntities: false,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name, jPath) => jPath === 'BrickStoreXML.Inventory.Item' || jPath === 'BrickStockXML.Inventory.Item' || jPath === 'INVENTORY.ITEM' || name === 'Inventory',
});

const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the predefined XML entities and character references; any other reference is left as it is. */
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return codePoint(Number.parseInt(name.slice(2), 16), whole);
    if (name.startsWith('#')) return codePoint(Number.parseInt(name.slice(1), 10), whole);
    return PREDEFINED[name] ?? whole;
  });
}

function codePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/** The text of one element of a lot: undefined when absent, refused when it isn't plain text. */
function text(item: Record<string, unknown>, name: string, index: number): string | undefined {
  const value = item[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new PartsFileRefused('invalid-lot', `the <${name}> element is not plain text`, { index });
  return decode(value).trim();
}

/** The element names each format keeps a lot's six fields in. */
const FIELDS = {
  BSX: { itemNo: 'ItemID', itemType: 'ItemTypeID', colorId: 'ColorID', quantity: 'Qty', price: 'Price', condition: 'Condition' },
  BL_XML: { itemNo: 'ITEMID', itemType: 'ITEMTYPE', colorId: 'COLOR', quantity: 'QTY', price: 'PRICE', condition: 'CONDITION' },
} as const;

function readLot(format: PartsFormat, raw: unknown, index: number): PartsLot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PartsFileRefused('invalid-lot', 'the lot is not an element of fields', { index });
  const item = raw as Record<string, unknown>;
  const names = FIELDS[format];
  const itemNo = text(item, names.itemNo, index);
  if (itemNo === undefined || itemNo === '') throw new PartsFileRefused('invalid-lot', 'the lot has no item number', { index });
  // Printable, without spaces at its ends, short: BrickLink's numbers are like 3001, 973pb1234c01 or 75192-1.
  if (itemNo.length > MAX_ITEM_NO || /[\p{Cc}\p{Cf}]/u.test(itemNo)) {
    throw new PartsFileRefused('invalid-lot', 'the item number is not one BrickLink writes', { index });
  }
  const at: RefusedLot = { index, itemNo };

  const itemType = text(item, names.itemType, index);
  if (itemType === undefined || !/^[A-Z]$/.test(itemType)) throw new PartsFileRefused('invalid-lot', 'the item type is not one letter such as P', at);

  const color = text(item, names.colorId, index);
  // BrickLink's export leaves the colour out of an item that has none, which BrickStore reads as 0.
  if (color !== undefined && !/^\d{1,6}$/.test(color)) throw new PartsFileRefused('invalid-lot', 'the colour id is not a whole number', at);
  const colorId = color === undefined ? 0 : Number(color);

  const qty = text(item, names.quantity, index);
  const quantity = qty === undefined ? 0 : /^\d{1,7}$/.test(qty) ? Number(qty) : Number.NaN;
  if (!(Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= MAX_LOT_QUANTITY)) {
    throw new PartsFileRefused('invalid-lot', 'the quantity is not a positive whole number', at);
  }

  const conditionText = text(item, names.condition, index);
  // Both formats leave a new lot's condition out when it is the default, new.
  if (conditionText !== undefined && conditionText !== 'N' && conditionText !== 'U') {
    throw new PartsFileRefused('invalid-lot', 'the condition is neither N nor U', at);
  }
  const condition: PartsCondition = conditionText === 'U' ? 'U' : 'N';

  const priceText = text(item, names.price, index);
  let unitPrice: number | null = null;
  if (priceText !== undefined && priceText !== '') {
    const price = /^\d{1,7}(\.\d{1,6})?$/.test(priceText) ? Number(priceText) : Number.NaN;
    if (!(Number.isFinite(price) && price >= 0 && price <= MAX_UNIT_PRICE)) throw new PartsFileRefused('invalid-lot', 'the price is not an amount', at);
    // BrickStore writes 0.000 for a lot with no price.
    unitPrice = price === 0 ? null : Math.round(price * 1000) / 1000;
  }

  return { itemType, itemNo, colorId, condition, quantity, unitPrice };
}

/** Reads a parts file's bytes. Throws `PartsFileRefused` for any file the import does not take. */
export function parsePartsFile(bytes: Uint8Array): ParsedPartsFile {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new PartsFileRefused('not-utf8', 'the file is not UTF-8 text');
  }

  // No entity declaration of any kind, and no DOCTYPE but the bare one: nothing to resolve.
  if (/<!ENTITY/i.test(xml)) throw new PartsFileRefused('doctype', 'the file declares an entity, which the import never resolves');
  const doctypes = xml.match(/<!DOCTYPE[^>]*>?/gi) ?? [];
  if (doctypes.length > 1 || doctypes.some((doctype) => !ALLOWED_DOCTYPE.test(doctype.trim()))) {
    throw new PartsFileRefused('doctype', 'the file has a document type definition, which the import never reads');
  }
  const body = xml.replace(/<!DOCTYPE[^>]*>/i, '');

  if (XMLValidator.validate(body) !== true) throw new PartsFileRefused('not-xml', 'the file is not well-formed XML');
  let document: Record<string, unknown>;
  try {
    document = parser.parse(body) as Record<string, unknown>;
  } catch {
    throw new PartsFileRefused('not-xml', 'the file is not well-formed XML');
  }

  const roots = Object.keys(document);
  let format: PartsFormat;
  let currency: string | null = null;
  let items: unknown[];
  if (roots.length === 1 && (roots[0] === 'BrickStoreXML' || roots[0] === 'BrickStockXML')) {
    format = 'BSX';
    const root = document[roots[0]];
    const inventories = typeof root === 'object' && root !== null ? (root as Record<string, unknown>).Inventory : undefined;
    if (!Array.isArray(inventories) || inventories.length !== 1) throw new PartsFileRefused('unknown-format', 'the BrickStore file has no single <Inventory>');
    const inventory = inventories[0] as unknown;
    if (typeof inventory === 'object' && inventory !== null) {
      const code = (inventory as Record<string, unknown>)['@_Currency'];
      if (typeof code === 'string' && /^[A-Z]{3}$/.test(code)) currency = code;
      const listed = (inventory as Record<string, unknown>).Item;
      items = Array.isArray(listed) ? listed : [];
    } else {
      items = [];
    }
  } else if (roots.length === 1 && roots[0] === 'INVENTORY') {
    format = 'BL_XML';
    const root = document.INVENTORY;
    const listed = typeof root === 'object' && root !== null ? (root as Record<string, unknown>).ITEM : undefined;
    items = Array.isArray(listed) ? listed : [];
  } else {
    throw new PartsFileRefused('unknown-format', 'the file is neither a BrickStore .bsx file nor a BrickLink XML inventory');
  }

  if (items.length === 0) throw new PartsFileRefused('no-lots', 'the file has no lots');
  if (items.length > MAX_LOTS) throw new PartsFileRefused('too-many-lots', `the file has ${items.length} lots, more than the ${MAX_LOTS} the import takes`);
  const lots = items.map((item, index) => readLot(format, item, index + 1));
  return { format, currency, lots };
}
