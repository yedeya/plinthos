/**
 * An item's cover as the printable catalogue embeds it ([EXP-5], #257): its stored thumbnail,
 * scaled down to print size and encoded as a `data:` URL, so the page arrives with every image and
 * the browser makes no request per photographed item. The page shows it 48 pixels square;
 * `PRINT_COVER_EDGE` is three times that, enough for a printer's resolution, and keeps a page of
 * hundreds of items small.
 *
 * The input is a stored size the re-encode wrote ([PHOTO-3]), so only WebP is decoded, within a
 * thumbnail's pixels; sharp writes no metadata unless asked to, so the output carries none.
 */
import sharp from 'sharp';
import { THUMBNAIL_EDGE } from './config';

/** The longest edge of a cover in the printable catalogue, in pixels. */
export const PRINT_COVER_EDGE = 144;

/** The most bytes a stored thumbnail is read for: far above a 320-pixel WebP's. */
export const MAX_COVER_BYTES = 512 * 1024;

const DECODE = { failOn: 'error', limitInputPixels: THUMBNAIL_EDGE * THUMBNAIL_EDGE } as const;

/** The stored thumbnail as a WebP `data:` URL at print size, or null when it is not a WebP sharp can decode. */
export async function printCover(stored: Uint8Array): Promise<string | null> {
  try {
    if ((await sharp(stored, DECODE).metadata()).format !== 'webp') return null;
    const scaled = await sharp(stored, DECODE).resize({ width: PRINT_COVER_EDGE, height: PRINT_COVER_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    return `data:image/webp;base64,${scaled.toString('base64')}`;
  } catch {
    return null;
  }
}
