/**
 * The set index's rows and the constants that read them (`./format.ts`), shared with the phone,
 * which keeps and searches the index (`src/app/_offline/set-index.ts`, [CAT-10], [CAT-11]). It
 * imports nothing, so the device's bundle and the data-free shell take it without the server's code.
 */

/** Where Rebrickable keeps the sets' and minifigures' stock images. */
export const SET_IMAGE_BASE = 'https://cdn.rebrickable.com/media/sets/';

/** The index's format, which a change of its shape raises. */
export const SET_INDEX_FORMAT = 1;

export type SetRow = [setNum: string, name: string, themeId: number, year: number, parts: number] | [setNum: string, name: string, themeId: number, year: number, parts: number, image: string];
export type MinifigRow = [figNum: string, name: string, parts: number];
export type ThemeRow = [id: number, name: string, parentId: number | null];

/** The three files the index is built from, and nothing else ([CAT-6]). */
export type SourceName = 'sets' | 'themes' | 'minifigs';
