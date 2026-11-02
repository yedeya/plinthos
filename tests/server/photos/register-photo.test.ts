import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { QUARANTINE_KEY, QUARANTINE_PREFIX, STORED_KEY } from '../../../src/server/photos/keys';
import { createPhotoService, REFUSALS } from '../../../src/server/photos/photos';
import { syncRegistry } from '../../../src/server/sync/registry';
import { createReplay, type MutationOutcome } from '../../../src/server/sync/replay';
import { logger } from '../../../src/server/logger';
import { afterCommit, inTransaction } from '../../../src/server/transaction';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { gpsPhoto, hasGpsIfd, MADE_UP, memoryBucket, plainPhoto, sha256, type MemoryBucket } from './fakes';

/**
 * `registerPhoto` and `deletePhoto` through the offline-sync replay, as the deployed endpoint runs
 * them, over the test database and an in-memory photo bucket ([PHOTO-1] to [PHOTO-6], #9).
 * `docs/qa/stack.md`'s `## Data isolation` holds this file for [PHOTO-3], [PHOTO-4] and [PHOTO-6]:
 * a quarantined object left after `registerPhoto`, or a stored size that keeps any metadata, is a
 * regression.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const MAX_BYTES = 256 * 1024;
const LONGEST_EDGE = 1024;

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let bucket: MemoryBucket;
let capture: ReturnType<typeof captureLogger>;
let failNow: boolean;

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  const url = new URL(readDatabaseUrl());
  url.pathname = `/${fresh.client.database ?? ''}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  state.db = drizzle(pool, { schema });
});
afterAll(async () => {
  await pool.end();
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('truncate applied_mutation, photo cascade');
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  bucket = memoryBucket();
  capture = captureLogger();
  failNow = false;
});

function service() {
  return createPhotoService({
    storage: () => bucket.storage,
    settings: () => ({ longestEdge: LONGEST_EDGE, maxBytes: MAX_BYTES }),
    now: () => {
      if (failNow) throw new Error('made-up failure after the files were written');
      return new Date();
    },
    log: capture.log,
  });
}

function replay() {
  return createReplay(syncRegistry(service().mutations), { log: capture.log });
}

/** Presigns an upload as the route does, and puts the bytes there as the phone's POST does. */
async function uploaded(bytes: Uint8Array): Promise<string> {
  const presigned = await service().presignPhotoUpload(admin, {});
  bucket.upload(presigned.key, bytes);
  return presigned.key;
}

async function register(id: string, quarantineKey: string, hash: string): Promise<MutationOutcome> {
  const { outcomes } = await replay()(admin, { mutations: [{ id, name: 'registerPhoto', input: { quarantineKey, sha256: hash } }] });
  const [outcome] = outcomes;
  if (outcome === undefined) throw new Error('no outcome');
  return outcome;
}

async function rows(table: 'photo' | 'applied_mutation'): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query(`select * from ${table}`)).rows as Record<string, unknown>[];
}

function quarantined(): string[] {
  return [...bucket.objects.keys()].filter((key) => key.startsWith(QUARANTINE_PREFIX));
}

function stored(): [string, Uint8Array][] {
  return [...bucket.objects.entries()].filter(([key]) => !key.startsWith(QUARANTINE_PREFIX)).map(([key, object]) => [key, object.body]);
}

describe('registerPhoto strips every piece of metadata', () => {
  it('[PHOTO-4] stores no EXIF, XMP, IPTC or GPS in any size of a JPEG put straight into the quarantine, keeps it upright, and leaves no quarantined object', async () => {
    const original = await gpsPhoto();
    // The fixture really carries what the stored sizes must not.
    const before = await sharp(original).metadata();
    expect(hasGpsIfd(before.exif)).toBe(true);
    expect(before.exif?.toString('latin1')).toContain(MADE_UP.model);
    expect(before.xmpAsString ?? before.xmp?.toString('utf8')).toContain(MADE_UP.xmpMarker);
    expect(before.orientation).toBe(6);
    expect([before.width, before.height]).toEqual([64, 32]);

    // Straight into the quarantine, without the phone's resize, as a hostile or broken client could.
    const key = await uploaded(original);
    const id = randomUUID();
    const outcome = await register(id, key, sha256(original));
    expect(outcome.outcome).toBe('applied');

    const sizes = stored();
    expect(sizes).toHaveLength(2);
    for (const [storedAt, body] of sizes) {
      const metadata = await sharp(body).metadata();
      expect(metadata.format, storedAt).toBe('webp');
      expect(metadata.exif, storedAt).toBeUndefined();
      expect(metadata.xmp, storedAt).toBeUndefined();
      expect(metadata.iptc, storedAt).toBeUndefined();
      expect(metadata.icc, storedAt).toBeUndefined();
      expect(metadata.orientation, storedAt).toBeUndefined();
      // No trace in the bytes either: no EXIF or XMP chunk, no made-up value.
      const text = Buffer.from(body).toString('latin1');
      for (const needle of ['Exif', 'EXIF', 'XMP ', 'xmpmeta', MADE_UP.make, MADE_UP.model, MADE_UP.xmpMarker, 'GPS']) expect(text, `${storedAt}: ${needle}`).not.toContain(needle);
      // Oriented as the original displayed: 32 wide and 64 tall, red on top and blue below.
      expect([metadata.width, metadata.height]).toEqual([32, 64]);
      const { data, info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
      const [topRed, , topBlue] = pixel(16, 8) as [number, number, number];
      const [bottomRed, , bottomBlue] = pixel(16, 56) as [number, number, number];
      expect(topRed).toBeGreaterThan(150);
      expect(topBlue).toBeLessThan(80);
      expect(bottomBlue).toBeGreaterThan(150);
      expect(bottomRed).toBeLessThan(80);
    }
    expect(quarantined()).toEqual([]);
    expect(bucket.objects.has(key)).toBe(false);
  });
});

describe('registerPhoto re-encodes, writes before it commits, and deletes the quarantined object', () => {
  it('[PHOTO-3] writes the full size and the thumbnail as WebP, only outside the quarantine, before the photo row commits, and deletes the upload after', async () => {
    const original = await plainPhoto(1600, 1200);
    const key = await uploaded(original);
    const seen: { call: string; photos: number }[] = [];
    // A second connection sees only what has committed.
    bucket.beforeChange = async (call) => {
      seen.push({ call: call.split(' ')[0] ?? call, photos: (await fresh.client.query('select 1 from photo')).rowCount ?? 0 });
    };
    const outcome = await register(randomUUID(), key, sha256(original));
    expect(outcome).toMatchObject({ outcome: 'applied', result: { photoId: expect.any(String) } });
    expect(seen).toEqual([
      { call: 'put', photos: 0 },
      { call: 'put', photos: 0 },
      { call: 'delete', photos: 1 },
    ]);
    const [row] = await rows('photo');
    const sizes = new Map(stored());
    const full = await sharp(sizes.get(String(row?.full_key))).metadata();
    const thumbnail = await sharp(sizes.get(String(row?.thumbnail_key))).metadata();
    expect([full.format, full.width, full.height]).toEqual(['webp', LONGEST_EDGE, 768]);
    expect([thumbnail.format, thumbnail.width, thumbnail.height]).toEqual(['webp', 320, 240]);
    for (const [storedAt, object] of bucket.objects) expect(object.contentType, storedAt).toBe('image/webp');
    expect(row?.sha256).toBe(sha256(original));
    expect(quarantined()).toEqual([]);
  });

  it('[PHOTO-3] a failure after the files were written records nothing, leaves only orphaned private files, and still deletes the upload', async () => {
    const original = await plainPhoto();
    const key = await uploaded(original);
    failNow = true;
    const id = randomUUID();
    const outcome = await register(id, key, sha256(original));
    expect(outcome.outcome).toBe('failed');
    expect(await rows('photo')).toEqual([]);
    expect(await rows('applied_mutation')).toEqual([]);
    expect(stored()).toHaveLength(2);
    expect(quarantined()).toEqual([]);
    const events = capture.events();
    expect(events.find((event) => event.businessEvent === 'sync.mutation.failed')).toMatchObject({ mutationId: id });
    expect(events.find((event) => event.businessEvent === 'photo.reencode.failed')).toMatchObject({ mutationId: id, reason: 'failed' });
  });

  it('[PHOTO-3] is a typed service function only an AdminContext from the session check can call', async () => {
    const original = await plainPhoto();
    const key = await uploaded(original);
    const forged = { sessionKey: randomUUID(), requestId: randomUUID() } as unknown as AdminContext;
    await expect(service().registerPhoto(forged, { quarantineKey: key, sha256: sha256(original) })).rejects.toThrow(NotAdminError);
    await expect(service().presignPhotoUpload(forged, {})).rejects.toThrow(NotAdminError);
    await expect(service().deletePhoto(forged, { photoId: randomUUID() })).rejects.toThrow(NotAdminError);
    await expect(service().listPhotos(forged)).rejects.toThrow(NotAdminError);
    expect(bucket.calls.filter((call) => !call.startsWith('presignUpload'))).toEqual([]);
  });

  it('[PHOTO-3] refuses a quarantine key it did not make, before it reads anything', async () => {
    for (const quarantineKey of ['photos/x.webp', 'quarantine/../photos/a.webp', `quarantine/${'A'.repeat(43)}.png`, 'other/key']) {
      const outcome = await register(randomUUID(), quarantineKey, sha256(new Uint8Array([1])));
      expect(outcome.outcome, quarantineKey).toBe('invalid');
    }
    expect(bucket.calls).toEqual([]);
  });
});

describe('registerPhoto is idempotent by the client’s id and the photo’s hash', () => {
  it('[PHOTO-2] [PHOTO-3] answers a replay of the same id and hash, even under a new quarantine key, as already applied, stores nothing more, and deletes the new upload (#9)', async () => {
    const original = await plainPhoto();
    const id = randomUUID();
    const first = await register(id, await uploaded(original), sha256(original));
    expect(first.outcome).toBe('applied');
    const files = stored().length;

    // The answer was lost, and the phone uploaded the same bytes again under a fresh key.
    const again = await uploaded(original);
    const second = await register(id, again, sha256(original));
    expect(second).toEqual({ id, outcome: 'already-applied', result: (first as { result: unknown }).result });
    expect(await rows('photo')).toHaveLength(1);
    expect(stored()).toHaveLength(files);
    expect(quarantined()).toEqual([]);
  });

  it('[PHOTO-2] [PHOTO-3] refuses the same id with another hash as a conflict, logs sync.conflict, stores nothing and deletes that upload', async () => {
    const original = await plainPhoto();
    const other = await plainPhoto(41, 30);
    const id = randomUUID();
    await register(id, await uploaded(original), sha256(original));
    const files = stored().length;
    const outcome = await register(id, await uploaded(other), sha256(other));
    expect(outcome).toMatchObject({ id, outcome: 'conflict', reason: 'payload' });
    expect(capture.events().find((event) => event.businessEvent === 'sync.conflict')).toMatchObject({ mutationId: id, mutation: 'registerPhoto' });
    expect(await rows('photo')).toHaveLength(1);
    expect(stored()).toHaveLength(files);
    expect(quarantined()).toEqual([]);
  });

  it('[PHOTO-2] records the photo’s hash, not the quarantine key, in the applied-mutation record', async () => {
    const original = await plainPhoto();
    const key = await uploaded(original);
    await register(randomUUID(), key, sha256(original));
    const [record] = await rows('applied_mutation');
    expect(JSON.stringify(record)).not.toContain(key);
  });
});

describe('registerPhoto refuses a bad upload, stores nothing and deletes it', () => {
  async function refused(bytes: Uint8Array, hash: string): Promise<{ id: string; outcome: MutationOutcome }> {
    const key = await uploaded(bytes);
    const id = randomUUID();
    const outcome = await register(id, key, hash);
    expect(await rows('photo')).toEqual([]);
    expect(await rows('applied_mutation')).toEqual([]);
    expect(stored()).toEqual([]);
    expect(bucket.calls.filter((call) => call.startsWith('put'))).toEqual([]);
    expect(quarantined()).toEqual([]);
    return { id, outcome };
  }

  it('[PHOTO-5] refuses bytes that are not an image, logging photo.reencode.failed with its id and never its bytes', async () => {
    const bytes = new TextEncoder().encode('made-up-not-a-photo-0f3a9c '.repeat(40));
    const { id, outcome } = await refused(bytes, sha256(bytes));
    expect(outcome).toMatchObject({ id, outcome: 'invalid', code: REFUSALS.undecodable });
    const event = capture.events().find((line) => line.businessEvent === 'photo.reencode.failed');
    expect(event).toMatchObject({ mutationId: id, reason: REFUSALS.undecodable, requestId: admin.requestId });
    expect(capture.lines.join('')).not.toContain('made-up-not-a-photo');
  });

  it('[PHOTO-5] refuses an image that is not a JPEG, and a truncated JPEG', async () => {
    const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer());
    expect((await refused(png, sha256(png))).outcome).toMatchObject({ outcome: 'invalid', code: REFUSALS.undecodable });
    const truncated = (await plainPhoto(300, 200)).subarray(0, 400);
    expect((await refused(truncated, sha256(truncated))).outcome).toMatchObject({ outcome: 'invalid', code: REFUSALS.undecodable });
  });

  it('[PHOTO-5] refuses bytes whose SHA-256 is not the mutation’s', async () => {
    const original = await plainPhoto();
    const { id, outcome } = await refused(original, sha256(new Uint8Array([1, 2, 3])));
    expect(outcome).toMatchObject({ id, outcome: 'invalid', code: REFUSALS.hash });
    expect(capture.events().find((line) => line.businessEvent === 'photo.reencode.failed')).toMatchObject({ mutationId: id, reason: REFUSALS.hash });
  });

  it('[PHOTO-1] refuses a quarantined object over the size cap before it decodes it, reading no more than the cap', async () => {
    const big = new Uint8Array(MAX_BYTES + 1);
    // Past the presigned upload's own cap, as a stand-in for an object S3 should never have taken.
    const key = (await service().presignPhotoUpload(admin, {})).key;
    bucket.objects.set(key, { body: big, contentType: 'image/jpeg' });
    const outcome = await register(randomUUID(), key, sha256(big));
    expect(outcome).toMatchObject({ outcome: 'invalid', code: REFUSALS.tooLarge });
    expect(bucket.reads).toEqual([{ key, maxBytes: MAX_BYTES }]);
    expect(stored()).toEqual([]);
    expect(quarantined()).toEqual([]);
  });

  it('[PHOTO-1] [PHOTO-7] the presigned upload carries the size cap, a JPEG content type and an expiry within 15 minutes', async () => {
    const presigned = await service().presignPhotoUpload(admin, {});
    expect(presigned.key).toMatch(QUARANTINE_KEY);
    expect(presigned.maxBytes).toBe(MAX_BYTES);
    expect(bucket.presigned).toEqual([{ key: presigned.key, conditions: { maxBytes: MAX_BYTES, expiresInSeconds: 600, contentType: 'image/jpeg' } }]);
    expect(new Date(presigned.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(() => bucket.upload(presigned.key, new Uint8Array(MAX_BYTES + 1))).toThrow(/EntityTooLarge/);
  });

  it('[PHOTO-8] answers a missing upload as upload-missing, records nothing and logs no re-encode failure, so the phone can upload again under the same id (#9)', async () => {
    const original = await plainPhoto();
    const key = (await service().presignPhotoUpload(admin, {})).key;
    const id = randomUUID();
    // Never uploaded, or expired by the lifecycle rule.
    const missing = await register(id, key, sha256(original));
    expect(missing).toMatchObject({ id, outcome: 'invalid', code: REFUSALS.missing });
    expect(await rows('applied_mutation')).toEqual([]);
    expect(capture.events().filter((line) => line.businessEvent === 'photo.reencode.failed')).toEqual([]);

    const again = await register(id, await uploaded(original), sha256(original));
    expect(again.outcome).toBe('applied');
    expect(await rows('photo')).toHaveLength(1);
    expect(quarantined()).toEqual([]);
  });
});

describe('stored photos', () => {
  it('[PHOTO-6] are stored under random keys the server makes, of 256 bits, that hold nothing the client sent', async () => {
    const id = randomUUID();
    const original = await plainPhoto();
    const quarantineKey = await uploaded(original);
    await register(id, quarantineKey, sha256(original));
    const [row] = await rows('photo');
    const keys = [String(row?.full_key), String(row?.thumbnail_key)];
    for (const key of keys) {
      expect(key).toMatch(STORED_KEY);
      expect(key).not.toContain(id);
      expect(key).not.toContain(id.replaceAll('-', ''));
      expect(key).not.toContain(sha256(original).slice(0, 16));
      expect(key).not.toContain(quarantineKey.slice(QUARANTINE_PREFIX.length, -4));
    }
    expect(new Set([...keys, quarantineKey]).size).toBe(3);
    expect(row?.id).not.toBe(id);
  });

  it('[PHOTO-6] are listed to the admin only through presigned reads of the stored sizes that expire within 15 minutes', async () => {
    const original = await plainPhoto();
    await register(randomUUID(), await uploaded(original), sha256(original));
    const listed = await service().listPhotos(admin);
    expect(listed).toHaveLength(1);
    expect(bucket.presignedReads).toHaveLength(2);
    for (const { key, expiresInSeconds } of bucket.presignedReads) {
      expect(key).toMatch(STORED_KEY);
      expect(expiresInSeconds).toBeLessThanOrEqual(15 * 60);
    }
    expect(listed[0]?.thumbnailUrl).toContain('X-Amz-Expires=600');
  });

  it('[PHOTO-6] [PHOTO-9] deletePhoto removes the row, then moves both stored sizes to the trash once that has committed; a second delete changes nothing', async () => {
    const original = await plainPhoto();
    const registered = await register(randomUUID(), await uploaded(original), sha256(original));
    const photoId = (registered as { result: { photoId: string } }).result.photoId;
    const seen: number[] = [];
    bucket.beforeChange = async () => {
      seen.push((await fresh.client.query('select 1 from photo')).rowCount ?? 0);
    };
    const run = replay();
    const first = await run(admin, { mutations: [{ id: randomUUID(), name: 'deletePhoto', input: { photoId } }] });
    expect(first.outcomes[0]).toMatchObject({ outcome: 'applied', result: { photoId, deleted: true } });
    expect(seen).toEqual([0, 0]);
    expect(await rows('photo')).toEqual([]);
    // Nothing is left under photos/: both sizes wait in the trash, under the same random part ([PHOTO-9]).
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((key) => key.startsWith('photos/'))).toEqual([]);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^trash\/[A-Za-z0-9_-]{43}\.webp$/.test(key))).toBe(true);
    const second = await run(admin, { mutations: [{ id: randomUUID(), name: 'deletePhoto', input: { photoId } }] });
    expect(second.outcomes[0]).toMatchObject({ outcome: 'applied', result: { photoId, deleted: false } });
  });
});

describe('afterCommit, which deletePhoto deletes its files through', () => {
  it('[PHOTO-6] runs its steps only after a commit, never after a rollback, and logs a step that throws rather than swallowing it', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const ran: string[] = [];
      await expect(
        inTransaction(async () => {
          afterCommit(async () => void ran.push('rolled back'));
          throw new Error('made-up rollback');
        }),
      ).rejects.toThrow('made-up rollback');
      expect(ran).toEqual([]);

      await inTransaction(async () => {
        afterCommit(async () => {
          throw new TypeError('made-up step failure');
        });
        afterCommit(async () => void ran.push('after the failing step'));
      });
      expect(ran).toEqual(['after the failing step']);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ businessEvent: 'transaction.after_commit.failed', cause: 'TypeError' }), expect.any(String));
      expect(JSON.stringify(error.mock.calls)).not.toContain('made-up step failure');
    } finally {
      error.mockRestore();
    }
  });
});
