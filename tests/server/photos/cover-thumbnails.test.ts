import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { storedKey } from '../../../src/server/photos/keys';
import { PRINT_COVER_EDGE } from '../../../src/server/photos/print-cover';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { memoryBucket, type MemoryBucket } from './fakes';

// The photo bucket is an in-memory one, and the database a fresh one of the test server's: CI has no AWS.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const { createPhotoService } = await import('../../../src/server/photos/photos');

/**
 * `readCoverThumbnails` (#257, [EXP-5]): the printable catalogue's covers, read on the server as
 * the page is made and handed to it as `data:` URLs, so the page arrives with every image and
 * the browser makes no request per photographed item, which a burst over the server function's
 * concurrency limit would throttle and leave blank. Each is the photo the catalogue shows first,
 * the cover, else the first in the admin's order, scaled down from its stored thumbnail. Nothing
 * is presigned, and no stored key leaves the server.
 */

const NOW = new Date('2026-11-04T08:00:00.000Z');
const DATA_URL = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/;

let fresh: FreshDatabase;
let bucket: MemoryBucket;
let logs: ReturnType<typeof captureLogger>;
let admin: AdminContext;

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  state.db = fresh.db;
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('truncate photo, collection_item cascade');
  bucket = memoryBucket();
  logs = captureLogger();
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
});

const service = () => createPhotoService({ storage: () => bucket.storage, log: logs.log });

async function anItem(): Promise<string> {
  const id = randomUUID();
  await fresh.db.insert(schema.collectionItem).values({ id, kind: 'OTHER', name: 'Made-up item', condition: 'SEALED', description: '', quantity: 1, storageLocation: 'made-up shelf', version: 1, createdAt: NOW, updatedAt: NOW });
  return id;
}

/** A stored thumbnail of one flat colour, as the re-encode writes it: WebP, at most 320 pixels, no metadata. */
async function thumbnail(red: number, width = 320, height = 240): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: red, g: 10, b: 10 } } }).webp({ quality: 70 }).toBuffer());
}

/** A photo of the item, at a position and added at a minute past `NOW`, its thumbnail in the bucket in the colour given. */
async function aPhoto(itemId: string, position: number | null, minute: number, red: number): Promise<{ id: string; thumbnailKey: string }> {
  const id = randomUUID();
  const thumbnailKey = storedKey();
  await fresh.db.insert(schema.photo).values({ id, itemId, position, fullKey: storedKey(), thumbnailKey, sha256: 'made-up', createdAt: new Date(NOW.getTime() + minute * 60_000) });
  bucket.objects.set(thumbnailKey, { body: await thumbnail(red), contentType: 'image/webp' });
  return { id, thumbnailKey };
}

/** The image a `data:` URL holds: its format, size, metadata and the red of its first pixel. */
async function decode(url: string | undefined) {
  const base64 = DATA_URL.exec(url ?? '')?.[1];
  if (base64 === undefined) throw new Error(`not a WebP data URL: ${String(url).slice(0, 40)}`);
  const image = sharp(Buffer.from(base64, 'base64'));
  const meta = await image.metadata();
  const { data } = await image.raw().toBuffer({ resolveWithObject: true });
  return { format: meta.format, width: meta.width, height: meta.height, exif: meta.exif, icc: meta.icc, xmp: meta.xmp, red: data[0] ?? -1 };
}

describe('readCoverThumbnails', () => {
  it('[EXP-5] answers each item’s cover as a WebP data URL scaled down for print, presigning nothing', async () => {
    const first = await anItem();
    await aPhoto(first, 0, 0, 40);
    const cover = await aPhoto(first, 1, 1, 200);
    await fresh.db.update(schema.collectionItem).set({ coverPhotoId: cover.id }).where(eq(schema.collectionItem.id, first));
    const second = await anItem();
    const secondCover = await aPhoto(second, 0, 0, 120);

    const covers = await service().readCoverThumbnails(admin, { itemIds: [first, second] });

    expect([...covers.keys()].sort()).toEqual([first, second].sort());
    const image = await decode(covers.get(first));
    expect(image.format).toBe('webp');
    // The stored thumbnail is 320×240; the print size fits PRINT_COVER_EDGE and keeps its shape.
    expect([image.width, image.height]).toEqual([PRINT_COVER_EDGE, Math.round((PRINT_COVER_EDGE * 240) / 320)]);
    expect([image.exif, image.icc, image.xmp]).toEqual([undefined, undefined, undefined]);
    // The item's chosen cover, not its first photo.
    expect(Math.abs(image.red - 200)).toBeLessThan(12);
    expect(Math.abs((await decode(covers.get(second))).red - 120)).toBeLessThan(12);
    // One read of each cover's stored thumbnail, and no presigned address for the browser to fetch.
    expect(bucket.reads.map((read) => read.key).sort()).toEqual([cover.thumbnailKey, secondCover.thumbnailKey].sort());
    expect(bucket.presignedReads).toEqual([]);
    for (const url of covers.values()) expect(url).not.toContain('photos/');
  });

  it('[EXP-5] takes the first photo in the admin’s order when the item names no cover, as the catalogue does', async () => {
    const item = await anItem();
    await aPhoto(item, null, 0, 30);
    await aPhoto(item, 2, 2, 230);
    await aPhoto(item, 5, 1, 90);
    const covers = await service().readCoverThumbnails(admin, { itemIds: [item] });
    expect(Math.abs((await decode(covers.get(item))).red - 230)).toBeLessThan(12);
  });

  it('[EXP-5] answers only the items asked for: none for an item without a photo, an unknown item, or one not asked for', async () => {
    const bare = await anItem();
    const other = await anItem();
    await aPhoto(other, 0, 0, 100);
    const covers = await service().readCoverThumbnails(admin, { itemIds: [bare, randomUUID()] });
    expect(covers.size).toBe(0);
    expect(bucket.reads).toEqual([]);
    expect((await service().readCoverThumbnails(admin, { itemIds: [] })).size).toBe(0);
  });

  it('[EXP-5] serves a whole catalogue from one call, reading a bounded number of covers at a time', async () => {
    const items: string[] = [];
    for (let index = 0; index < 30; index++) {
      const item = await anItem();
      await aPhoto(item, 0, index, 100);
      items.push(item);
    }
    let inFlight = 0;
    let most = 0;
    const read = bucket.storage.read.bind(bucket.storage);
    const slow = { ...bucket.storage, read: async (key: string, maxBytes: number) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await read(key, maxBytes);
      } finally {
        inFlight -= 1;
      }
    } };
    const covers = await createPhotoService({ storage: () => slow, log: logs.log }).readCoverThumbnails(admin, { itemIds: items });
    expect(covers.size).toBe(30);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });

  it('[EXP-5] leaves out a cover it cannot read, and logs photo.cover.unreadable with the item, never the key', async () => {
    const gone = await anItem();
    const goneKey = (await aPhoto(gone, 0, 0, 100)).thumbnailKey;
    bucket.objects.delete(goneKey);
    const broken = await anItem();
    const brokenKey = (await aPhoto(broken, 0, 0, 100)).thumbnailKey;
    bucket.objects.set(brokenKey, { body: new TextEncoder().encode('not an image'), contentType: 'image/webp' });
    const huge = await anItem();
    const hugeKey = (await aPhoto(huge, 0, 0, 100)).thumbnailKey;
    bucket.objects.set(hugeKey, { body: new Uint8Array(2 * 1024 * 1024), contentType: 'image/webp' });
    const fine = await anItem();
    await aPhoto(fine, 0, 0, 100);

    const covers = await service().readCoverThumbnails(admin, { itemIds: [gone, broken, huge, fine] });

    expect([...covers.keys()]).toEqual([fine]);
    const events = logs.events().filter((event) => event.businessEvent === 'photo.cover.unreadable');
    expect(events.map((event) => [event.itemId, event.reason]).sort()).toEqual(
      [
        [gone, 'missing'],
        [broken, 'undecodable'],
        [huge, 'too-large'],
      ].sort(),
    );
    for (const event of events) expect(event.requestId).toBe(admin.requestId);
    for (const line of logs.lines) for (const key of [goneKey, brokenKey, hugeKey]) expect(line).not.toContain(key);
  });

  it('[EXP-5] fails when the bucket fails, rather than print the catalogue without its covers', async () => {
    const item = await anItem();
    await aPhoto(item, 0, 0, 100);
    const failing = { ...bucket.storage, read: async () => Promise.reject(new Error('made-up S3 failure')) };
    await expect(createPhotoService({ storage: () => failing, log: logs.log }).readCoverThumbnails(admin, { itemIds: [item] })).rejects.toThrow('made-up S3 failure');
  });

  it('[EXP-5] refuses a caller that is not the admin, and an id that is not one', async () => {
    await expect(service().readCoverThumbnails({} as AdminContext, { itemIds: [randomUUID()] })).rejects.toThrow(NotAdminError);
    await expect(service().readCoverThumbnails(admin, { itemIds: ['not-an-id'] })).rejects.toThrow();
    expect(bucket.reads).toEqual([]);
  });
});
