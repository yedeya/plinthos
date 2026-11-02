/**
 * Stand-ins for the photo path's tests: an in-memory photo bucket behind the photo module's
 * storage interface, since CI has no AWS (brief #6, Issue J), and synthetic photos made in the
 * test itself. No real photo is ever used: every image here is drawn from flat colours, and its
 * EXIF, GPS and XMP are made up.
 */
import { trashKeyFor } from '../../../src/server/photos/keys';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { PhotoStorage, UploadConditions } from '../../../src/server/photos/storage';

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface MemoryBucket {
  readonly objects: Map<string, StoredObject>;
  /** Every call, in order, as `<method> <key>`. */
  readonly calls: string[];
  readonly presigned: { key: string; conditions: UploadConditions }[];
  readonly reads: { key: string; maxBytes: number }[];
  readonly presignedReads: { key: string; expiresInSeconds: number }[];
  /** Runs before each write and each delete, so a test can look at the database at that moment. */
  beforeChange?: (call: string) => Promise<void>;
  readonly storage: PhotoStorage;
  /** What the phone's presigned POST does: puts bytes at a presigned key, refusing a body over its cap as S3 would. */
  upload(key: string, body: Uint8Array): void;
}

export function memoryBucket(): MemoryBucket {
  const bucket: MemoryBucket = {
    objects: new Map(),
    calls: [],
    presigned: [],
    reads: [],
    presignedReads: [],
    storage: {
      async presignUpload(key, conditions) {
        bucket.calls.push(`presignUpload ${key}`);
        bucket.presigned.push({ key, conditions });
        return { url: 'https://photos.fake-s3.test/', fields: { key, 'Content-Type': conditions.contentType, Policy: 'made-up-policy' } };
      },
      async read(key, maxBytes) {
        bucket.calls.push(`read ${key}`);
        bucket.reads.push({ key, maxBytes });
        const object = bucket.objects.get(key);
        if (object === undefined) return { status: 'missing' };
        if (object.body.byteLength > maxBytes) return { status: 'too-large', bytes: object.body.byteLength };
        return { status: 'read', body: object.body };
      },
      async put(key, body, contentType) {
        await bucket.beforeChange?.(`put ${key}`);
        bucket.calls.push(`put ${key}`);
        bucket.objects.set(key, { body, contentType });
      },
      async delete(key) {
        await bucket.beforeChange?.(`delete ${key}`);
        bucket.calls.push(`delete ${key}`);
        bucket.objects.delete(key);
      },
      async trash(key) {
        await bucket.beforeChange?.(`trash ${key}`);
        bucket.calls.push(`trash ${key}`);
        const object = bucket.objects.get(key);
        if (object === undefined) return;
        bucket.objects.set(trashKeyFor(key), object);
        bucket.objects.delete(key);
      },
      async presignRead(key, expiresInSeconds) {
        bucket.calls.push(`presignRead ${key}`);
        bucket.presignedReads.push({ key, expiresInSeconds });
        return `https://photos.fake-s3.test/${key}?X-Amz-Expires=${expiresInSeconds}`;
      },
    },
    upload(key, body) {
      const presign = bucket.presigned.find((entry) => entry.key === key);
      if (presign === undefined) throw new Error(`no upload was presigned for ${key}`);
      if (body.byteLength > presign.conditions.maxBytes) throw new Error('EntityTooLarge');
      bucket.objects.set(key, { body, contentType: presign.conditions.contentType });
    },
  };
  return bucket;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The made-up values the GPS photo carries, which no stored size may. */
export const MADE_UP = {
  make: 'Made-up Optics',
  model: 'Made-up Camera 9000',
  latitude: '1/1 2/1 300/100',
  longitude: '4/1 5/1 600/100',
  xmpMarker: 'made-up-xmp-location-0f3a9c',
} as const;

/**
 * A 64×32 JPEG whose left half is red and right half blue, stored sideways with EXIF orientation
 * 6, so it displays as 32×64 with red on top. It carries made-up EXIF (make and model), a made-up
 * GPS position and an XMP packet that names a made-up place.
 */
export async function gpsPhoto(): Promise<Uint8Array> {
  const width = 64;
  const height = 32;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      if (x < width / 2) pixels[at] = 220;
      else pixels[at + 2] = 220;
    }
  }
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:City="${MADE_UP.xmpMarker}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: MADE_UP.make, Model: MADE_UP.model },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: MADE_UP.latitude, GPSLongitudeRef: 'E', GPSLongitude: MADE_UP.longitude },
    })
    .withXmp(xmp)
    .toBuffer();
  return new Uint8Array(jpeg);
}

/** A plain JPEG of one colour, with no metadata. */
export async function plainPhoto(width = 40, height = 30): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 40 } } }).jpeg().toBuffer());
}

/**
 * Whether an EXIF block (as sharp's `metadata().exif` gives it, `Exif\0\0` then TIFF) has a GPS
 * IFD: tag 0x8825 in IFD0. A small reader, so the test proves its own fixture carries GPS.
 */
export function hasGpsIfd(exif: Buffer | undefined): boolean {
  if (exif === undefined) return false;
  const tiff = exif.subarray(exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0);
  const little = tiff.subarray(0, 2).toString('latin1') === 'II';
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd0 = u32(4);
  const entries = u16(ifd0);
  for (let index = 0; index < entries; index++) {
    if (u16(ifd0 + 2 + index * 12) === 0x8825) return true;
  }
  return false;
}
