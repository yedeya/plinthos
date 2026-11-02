import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_LOTS, parsePartsFile, PartsFileRefused, type PartsLot } from '../../../src/server/parts/parse';
import { readRepoFile } from '../../support/repo-file';

/**
 * The parts file parser (`src/server/parts/parse.ts`, #160). Every fixture is made up
 * (`tests/fixtures/parts/`): the remarks hold made-up bin locations, and each field the parser
 * must drop holds a `CANARY` the output must not carry.
 */

const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) => readRepoFile(`tests/fixtures/parts/${name}`);

function refusal(text: string | Uint8Array): PartsFileRefused {
  try {
    parsePartsFile(typeof text === 'string' ? bytes(text) : text);
  } catch (error) {
    if (error instanceof PartsFileRefused) return error;
    throw error;
  }
  throw new Error('the file was not refused');
}

const bsx = (items: string) => `<?xml version="1.0"?><BrickStoreXML><Inventory Currency="EUR">${items}</Inventory></BrickStoreXML>`;
const bl = (items: string) => `<?xml version="1.0"?><INVENTORY>${items}</INVENTORY>`;

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the two formats', () => {
  it('[PARTS-1] reads a BrickStore .bsx file: item type, item number, colour, condition, quantity and unit price, and nothing else', () => {
    const parsed = parsePartsFile(bytes(fixture('made-up.bsx')));
    expect(parsed.format).toBe('BSX');
    expect(parsed.currency).toBe('EUR');
    expect(parsed.lots).toEqual<PartsLot[]>([
      { itemType: 'P', itemNo: '3001', colorId: 5, condition: 'N', quantity: 120, unitPrice: 0.085 },
      // BrickStore writes 0.000 for no price.
      { itemType: 'P', itemNo: '3069b', colorId: 11, condition: 'U', quantity: 45, unitPrice: null },
      // A lot with no condition is new, as BrickStore reads it.
      { itemType: 'M', itemNo: 'sw0001a', colorId: 0, condition: 'N', quantity: 2, unitPrice: 3.5 },
    ]);
    for (const lot of parsed.lots) expect(Object.keys(lot).sort()).toEqual(['colorId', 'condition', 'itemNo', 'itemType', 'quantity', 'unitPrice']);
  });

  it('[PARTS-1] reads a BrickLink XML inventory export the same way', () => {
    const parsed = parsePartsFile(bytes(fixture('made-up-bricklink.xml')));
    expect(parsed).toEqual({
      format: 'BL_XML',
      currency: null,
      lots: [
        { itemType: 'P', itemNo: '3023', colorId: 86, condition: 'U', quantity: 300, unitPrice: 0.02 },
        // BrickLink leaves out the colour of an item that has none, and the condition of a new one.
        { itemType: 'P', itemNo: '973pb0001c01', colorId: 0, condition: 'N', quantity: 1, unitPrice: null },
      ],
    });
  });

  it('[PARTS-1] never returns a remark, a comment, a cost, a reservation or any other field of either file', () => {
    for (const name of ['made-up.bsx', 'made-up-bricklink.xml']) {
      const text = fixture(name);
      expect(text).toContain('BIN-CANARY');
      const output = JSON.stringify(parsePartsFile(bytes(text)));
      expect(output, name).not.toMatch(/CANARY|shelf|drawer|tray|bin |0\.041|0\.075|0\.01\b/i);
    }
  });

  it('[PARTS-1] reads the older BrickStockXML root, a byte-order mark, and the predefined entities in the fields it keeps', () => {
    const parsed = parsePartsFile(
      bytes(`\uFEFF<?xml version="1.0"?><!DOCTYPE BrickStockXML><BrickStockXML><Inventory><Item><ItemID>x&amp;&#121;</ItemID><ItemTypeID>P</ItemTypeID><ColorID>1</ColorID><Qty>3</Qty></Item></Inventory></BrickStockXML>`),
    );
    expect(parsed).toEqual({ format: 'BSX', currency: null, lots: [{ itemType: 'P', itemNo: 'x&y', colorId: 1, condition: 'N', quantity: 3, unitPrice: null }] });
  });
});

describe('what it refuses', () => {
  it('[PARTS-1] refuses a file that is neither format, or not XML, or not UTF-8', () => {
    expect(refusal('<?xml version="1.0"?><ORDER><ITEM><ITEMID>3001</ITEMID></ITEM></ORDER>').code).toBe('unknown-format');
    expect(refusal('{"lots": []}').code).toBe('not-xml');
    expect(refusal('<INVENTORY><ITEM></INVENTORY>').code).toBe('not-xml');
    expect(refusal(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])).code).toBe('not-utf8');
    expect(refusal('<BrickStoreXML></BrickStoreXML>').code).toBe('unknown-format');
  });

  it('[PARTS-1] refuses a file with no lots', () => {
    expect(refusal(bsx('')).code).toBe('no-lots');
    expect(refusal(bl('')).code).toBe('no-lots');
    expect(refusal(bl('')).lot).toBeUndefined();
  });

  it('[PARTS-1] refuses a lot without an item number and names it by its place in the file', () => {
    const lot = (id: string) => `<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>${id}</ITEMID><QTY>1</QTY></ITEM>`;
    const refused = refusal(bl(`${lot('3001')}${lot('3002')}<ITEM><ITEMTYPE>P</ITEMTYPE><QTY>1</QTY><REMARKS>BIN-CANARY</REMARKS></ITEM>${lot('')}`));
    expect(refused.code).toBe('invalid-lot');
    expect(refused.lot).toEqual({ index: 3 });
    expect(refused.message).toMatch(/^lot 3: the lot has no item number$/);
    expect(refusal(bl(`${lot('3001')}${lot(' ')}`)).lot).toEqual({ index: 2 });
  });

  it('[PARTS-1] refuses a lot whose quantity is not a positive whole number, naming the first one, never its remark', () => {
    const item = (qty: string) => `<Item><ItemID>3001</ItemID><ItemTypeID>P</ItemTypeID><ColorID>1</ColorID>${qty}<Remarks>BIN-CANARY-Q</Remarks></Item>`;
    for (const qty of ['', '<Qty>0</Qty>', '<Qty>-4</Qty>', '<Qty>2.5</Qty>', '<Qty>many</Qty>', '<Qty>1,752</Qty>', '<Qty>99999999</Qty>']) {
      const refused = refusal(bsx(`${item('<Qty>1</Qty>')}${item(qty)}${item('<Qty>0</Qty>')}`));
      expect(refused.code, qty).toBe('invalid-lot');
      expect(refused.lot, qty).toEqual({ index: 2, itemNo: '3001' });
      expect(JSON.stringify({ ...refused, message: refused.message })).not.toContain('CANARY');
    }
  });

  it('[PARTS-1] refuses a lot whose type, colour, condition or price is not one the formats write', () => {
    const item = (fields: string) => bsx(`<Item><ItemID>3001</ItemID><Qty>1</Qty>${fields}</Item>`);
    expect(parsePartsFile(bytes(item('<ItemTypeID>P</ItemTypeID><ColorID>1</ColorID>'))).lots).toHaveLength(1);
    for (const fields of [
      '<ColorID>1</ColorID>',
      '<ItemTypeID>Part</ItemTypeID><ColorID>1</ColorID>',
      '<ItemTypeID>P</ItemTypeID><ColorID>red</ColorID>',
      '<ItemTypeID>P</ItemTypeID><ColorID>1</ColorID><Condition>X</Condition>',
      '<ItemTypeID>P</ItemTypeID><ColorID>1</ColorID><Price>-1</Price>',
      '<ItemTypeID>P</ItemTypeID><ColorID>1</ColorID><Price>1e3</Price>',
      '<ItemTypeID>P</ItemTypeID><ColorID>1</ColorID><Qty>2</Qty>',
    ]) {
      expect(refusal(item(fields)).code, fields).toBe('invalid-lot');
    }
  });

  it('[PARTS-1] refuses a file with more lots than the import takes', () => {
    const lot = '<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>3001</ITEMID><QTY>1</QTY></ITEM>';
    expect(refusal(bl(lot.repeat(MAX_LOTS + 1))).code).toBe('too-many-lots');
  });
});

describe('entities and DTDs', () => {
  it('[PARTS-1] never resolves an external entity: an XXE attempt is refused and reads nothing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plinthos-xxe-'));
    created.push(directory);
    const secret = join(directory, 'secret.txt');
    writeFileSync(secret, 'XXE-CANARY-the-server-file');
    const attack = fixture('xxe.bsx').replace('__CANARY_PATH__', secret);
    const refused = refusal(attack);
    expect(refused.code).toBe('doctype');
    expect(`${refused.message} ${JSON.stringify(refused)}`).not.toContain('XXE-CANARY');
  });

  it('[PARTS-1] refuses every DTD but the bare one older BrickStore files carry: internal entities, parameter entities, external DTDs', () => {
    const lot = '<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>&a;</ITEMID><QTY>1</QTY></ITEM>';
    for (const doctype of [
      '<!DOCTYPE INVENTORY [<!ENTITY a "3001">]>',
      '<!DOCTYPE INVENTORY [<!ENTITY % p SYSTEM "http://127.0.0.1/evil.dtd"> %p;]>',
      '<!DOCTYPE INVENTORY SYSTEM "http://127.0.0.1/evil.dtd">',
      '<!DOCTYPE INVENTORY PUBLIC "-//x//EN" "file:///etc/passwd">',
      '<!DOCTYPE INVENTORY><!DOCTYPE INVENTORY>',
    ]) {
      expect(refusal(`<?xml version="1.0"?>${doctype}<INVENTORY>${lot}</INVENTORY>`).code, doctype).toBe('doctype');
    }
    // A billion-laughs file is refused before anything expands.
    const laughs = `<!DOCTYPE INVENTORY [<!ENTITY l "lol">${Array.from({ length: 9 }, (_, n) => `<!ENTITY l${n + 1} "${`&l${n === 0 ? '' : n};`.repeat(10)}">`).join('')}]><INVENTORY>${lot.replace('&a;', '&l9;')}</INVENTORY>`;
    expect(refusal(laughs).code).toBe('doctype');
  });

  it('[PARTS-1] leaves an undeclared entity as it stands, never looking it up', () => {
    const parsed = parsePartsFile(bytes(bl('<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>3001&nbsp;</ITEMID><QTY>1</QTY></ITEM>')));
    expect(parsed.lots[0]?.itemNo).toBe('3001&nbsp;');
  });
});
