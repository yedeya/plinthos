/**
 * The re-encoding step `AGENTS.md` §1 requires of every upload, the full size included
 * ([PHOTO-3], [PHOTO-4]). sharp decodes the quarantined JPEG, turns it upright from its EXIF
 * orientation, and encodes each stored size afresh as WebP. sharp writes no metadata unless asked
 * to, so EXIF, GPS, XMP, IPTC, the camera's make and model and the ICC profile are all left
 * behind; each output is then decoded again and refused if any metadata came through.
 *
 * Only JPEG is accepted: the phone re-compresses every photo as JPEG before it queues it
 * ([PHOTO-1]), so anything else did not come from the admin's client, and refusing it keeps the
 * other decoders sharp carries (SVG, HEIF, TIFF and the rest) off the server.
 */
import sharp from 'sharp';
import { THUMBNAIL_EDGE } from './config';

/** The most pixels a decoded photo may hold: far above any phone's, far below what would exhaust the function. */
export const MAX_INPUT_PIXELS = 60_000_000;

export interface EncodedSize {
  readonly body: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface EncodedPhoto {
  readonly full: EncodedSize;
  readonly thumbnail: EncodedSize;
}

/** Thrown when the bytes are not a JPEG sharp can decode and re-encode. */
export class UndecodablePhoto extends Error {
  override name = 'UndecodablePhoto';
}

async function encode(input: Uint8Array, edge: number, quality: number): Promise<EncodedSize> {
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  const written = await sharp(data).metadata();
  if (written.exif !== undefined || written.xmp !== undefined || written.iptc !== undefined || written.icc !== undefined) {
    throw new Error('a re-encoded size still carries metadata');
  }
  return { body: new Uint8Array(data), width: info.width, height: info.height };
}

/** Re-encodes a quarantined JPEG into the stored sizes: the full size, at most `longestEdge`, and the thumbnail. */
export async function reencodePhoto(input: Uint8Array, options: { readonly longestEdge: number }): Promise<EncodedPhoto> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch (error) {
    throw new UndecodablePhoto('the upload is not an image sharp can read', { cause: error });
  }
  if (format !== 'jpeg') throw new UndecodablePhoto(`the upload is ${format ?? 'not an image'}, not a JPEG`);
  try {
    return {
      full: await encode(input, options.longestEdge, 82),
      thumbnail: await encode(input, Math.min(THUMBNAIL_EDGE, options.longestEdge), 70),
    };
  } catch (error) {
    throw new UndecodablePhoto('the upload could not be decoded and re-encoded', { cause: error });
  }
}
