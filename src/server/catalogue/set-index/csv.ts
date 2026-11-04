/**
 * A small RFC 4180 parser for Rebrickable's download files (brief #252, Issue A). It adds no
 * dependency.
 *
 * Fields are separated by commas and records by CRLF, LF or CR. A field in double quotes may hold
 * commas, line breaks and doubled quotes, which stand for one: a name such as
 * `"Sticker Sheet for Sets 618-1, 628-2"` holds a comma, and a name with a quote in it is written
 * with two. A quote inside an unquoted field is kept as it is, as is anything after a closing quote
 * before the next separator. A leading byte order mark and blank lines are dropped.
 *
 * A quoted field that never closes would swallow the rest of the file, so it throws `CsvError`
 * rather than answer what it swallowed. Every other record is answered as it is: checking a
 * record's field count and values is the caller's (`./build.ts`).
 */

export class CsvError extends Error {
  override name = 'CsvError';
}

/** Every record of the text, each as its fields. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  // Whether the current record has any content yet, so a blank line adds no record.
  let started = false;
  let quoted = false;
  let quotedAt = -1;
  let index = text.startsWith('﻿') ? 1 : 0;

  const endRecord = () => {
    if (started) {
      record.push(field);
      records.push(record);
    }
    record = [];
    field = '';
    started = false;
  };

  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      started = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRecord();
    } else if (char === '"' && field === '' && (index === 0 || ',\r\n﻿'.includes(text[index - 1] ?? ''))) {
      quoted = true;
      quotedAt = index;
      started = true;
    } else {
      field += char;
      started = true;
    }
  }
  if (quoted) throw new CsvError(`a quoted field opened at character ${quotedAt} never closes`);
  endRecord();
  return records;
}
