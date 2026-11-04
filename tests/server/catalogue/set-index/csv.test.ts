/**
 * The set index's RFC 4180 parser (brief #252, Issue A), on its own: quoted commas, doubled
 * quotes, line breaks inside a quoted field and the line endings the files may use. Every row is
 * made up.
 */
import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from '../../../../src/server/catalogue/set-index/csv';

describe('parseCsv', () => {
  it('splits plain records and fields, with or without a final line break', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps a comma and a doubled quote inside a quoted field, as a name like a sticker sheet’s holds both', () => {
    const text = 'set_num,name,year\n90001-1,"Sticker Sheet for Sets 90001-1, 90002-2",2031\n90003-1,"The ""Made-up"" Lighthouse, Deluxe",2032\n';
    expect(parseCsv(text)).toEqual([
      ['set_num', 'name', 'year'],
      ['90001-1', 'Sticker Sheet for Sets 90001-1, 90002-2', '2031'],
      ['90003-1', 'The "Made-up" Lighthouse, Deluxe', '2032'],
    ]);
  });

  it('keeps a line break inside a quoted field, and reads CRLF, LF and CR line endings alike', () => {
    expect(parseCsv('a,b\r\n"one\r\ntwo",3\r\n')).toEqual([
      ['a', 'b'],
      ['one\r\ntwo', '3'],
    ]);
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty fields, a quoted empty field and a trailing empty field', () => {
    expect(parseCsv('a,b,c\n,"",\n')).toEqual([
      ['a', 'b', 'c'],
      ['', '', ''],
    ]);
  });

  it('drops a byte order mark and blank lines', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('answers no records for an empty text', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('refuses a quoted field that never closes, which would swallow the rest of the file', () => {
    expect(() => parseCsv('a,b\n"open,2\n3,4\n')).toThrow(CsvError);
  });

  it('keeps a stray quote inside an unquoted field as it is', () => {
    expect(parseCsv('a,b\n12" figure,2\n')).toEqual([
      ['a', 'b'],
      ['12" figure', '2'],
    ]);
  });
});
