import { describe, expect, it } from 'vitest';
import { BOM, csvCell, writeCsv } from '../../../src/server/export/csv';
import { exportFileName } from '../../../src/server/export/export';

/**
 * `[EXP-4]`: the export's CSV writer on its own (`src/server/export/csv.ts`): UTF-8 with a
 * byte-order mark, CRLF line ends, a header row, RFC 4180 quoting, plain decimals, ISO dates,
 * `yes`/`no`/empty booleans, and a leading `'` on every cell a spreadsheet would run as a formula.
 * Every value is made up.
 */

describe('the export’s CSV writer', () => {
  it('[EXP-4] starts with a byte-order mark, writes a header row and ends every line with CRLF', () => {
    const csv = writeCsv(['A', 'B'], [
      ['one', 'two'],
      ['three', 'four'],
    ]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(BOM).toBe('\uFEFF');
    expect(csv).toBe('\uFEFFA,B\r\none,two\r\nthree,four\r\n');
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    // A header alone, for an empty collection.
    expect(writeCsv(['A'], [])).toBe('\uFEFFA\r\n');
  });

  it('[EXP-4] quotes a cell with a comma, a quote or a line break as RFC 4180 does, and no other', () => {
    expect(csvCell('plain text')).toBe('plain text');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('the "Falcon"')).toBe('"the ""Falcon"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('line one\r\nline two')).toBe('"line one\r\nline two"');
    expect(csvCell('Ünïcödé · 𝄞')).toBe('Ünïcödé · 𝄞');
  });

  it('[EXP-4] writes amounts as plain decimals with a dot and no thousands separator, never in exponent form', () => {
    expect(csvCell(1234567.5)).toBe('1234567.5');
    expect(csvCell(12.25)).toBe('12.25');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(1e21)).toBe('1000000000000000000000');
    expect(csvCell(1.5e-7)).toBe('0.00000015');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('[EXP-4] writes dates as ISO 8601 and booleans as yes, no or empty', () => {
    expect(csvCell(new Date(Date.UTC(2026, 10, 3, 9, 30, 0)))).toBe('2026-11-03T09:30:00.000Z');
    expect(csvCell('2026-11-03')).toBe('2026-11-03');
    expect(csvCell(new Date(Number.NaN))).toBe('');
    expect(csvCell(true)).toBe('yes');
    expect(csvCell(false)).toBe('no');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('[EXP-4] writes a leading apostrophe on a cell that starts with =, +, -, @, a tab or a carriage return', () => {
    for (const [cell, written] of [
      ['=HYPERLINK("https://example.test","x")', `"'=HYPERLINK(""https://example.test"",""x"")"`],
      ['+1+1', "'+1+1"],
      ['-2+3', "'-2+3"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\t=1', "'\t=1"],
      ['\r=1', `"'\r=1"`],
      ['=1,2', `"'=1,2"`],
    ] as const) {
      expect(csvCell(cell), JSON.stringify(cell)).toBe(written);
    }
    // Only the first character counts: a formula sign inside a cell is plain text.
    expect(csvCell('a=1')).toBe('a=1');
    expect(csvCell('Missing: 2x 3001 - red')).toBe('Missing: 2x 3001 - red');
    // In a whole file too.
    expect(writeCsv(['Description'], [['=cmd|"/c calc"!A1']])).toBe(`\uFEFFDescription\r\n"'=cmd|""/c calc""!A1"\r\n`);
  });

  it('[EXP-4] names the file by its preset and the day, in UTC', () => {
    expect(exportFileName('buyer', new Date('2026-11-03T23:30:00.000Z'))).toBe('plinthos-buyer-2026-11-03.csv');
    expect(exportFileName('full', new Date('2026-11-04T00:10:00.000Z'))).toBe('plinthos-full-2026-11-04.csv');
  });
});
