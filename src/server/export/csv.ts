/**
 * The export's CSV writer ([EXP-4], #236): pure, so it is tested on its own. A file is UTF-8 with a
 * byte-order mark, comma-separated, with CRLF line ends, a header row and RFC 4180 quoting, which
 * spreadsheet programs open as they are.
 *
 * Each cell is written from its type:
 * - a number as a plain decimal, with a dot and no thousands separator, never in exponent form;
 * - a `Date` as an ISO 8601 instant, in UTC; a day the caller has as `YYYY-MM-DD` is text already;
 * - a boolean as `yes` or `no`, and `null` or `undefined` as an empty cell;
 * - text as it is.
 *
 * **A CSV is code to a spreadsheet.** A cell that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return is written with a leading `'`, so no spreadsheet runs it as a formula (OWASP's
 * set). The rule applies to every cell, whatever its type: no amount, count or year the export
 * writes is negative, so it never turns a number into text.
 */

/** What a cell can hold. */
export type CsvCell = string | number | boolean | Date | null | undefined;

/** The leading characters a spreadsheet reads as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Exponent form's way out: every digit, a dot for decimals, no grouping, in no locale but `en`. */
const PLAIN = new Intl.NumberFormat('en', { useGrouping: false, maximumFractionDigits: 20 });

/** A number as a plain decimal: `1234.5`, never `1,234.5` or `1.2345e3`. */
function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  const text = String(value);
  // Exponent form, for a very large or very small number: the full decimal instead.
  return /e/i.test(text) ? PLAIN.format(value) : text;
}

/** One cell's text, before quoting. */
function cellText(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return plainNumber(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  return value;
}

/** One cell as the file holds it: formula-escaped, then quoted when RFC 4180 needs it. */
export function csvCell(value: CsvCell): string {
  const raw = cellText(value);
  const text = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The byte-order mark the file starts with, so a spreadsheet reads it as UTF-8. */
export const BOM = String.fromCharCode(0xfeff);

/** A whole file: the mark, the header row, then one row per entry, each line ended by CRLF. */
export function writeCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const line = (cells: readonly CsvCell[]) => `${cells.map(csvCell).join(',')}\r\n`;
  return BOM + line(header) + rows.map(line).join('');
}
