import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { catalogueSettings } from '../../../src/db/schema/catalogue-settings';
import { CLASSIFICATION } from '../../../src/db/schema/classification';
import { NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { reencodePhoto } from '../../../src/server/photos/reencode';
import type { PublicCatalogueData } from '../../../src/server/publish/catalogue-data';
import { createPublishStep, type PublishDependencies } from '../../../src/server/publish/publish';
import { SNAPSHOT_CACHE_CONTROL, WRITE_CONCURRENCY } from '../../../src/server/publish/snapshot';
import { isCatalogueToken } from '../../../src/server/publish/token';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { gpsPhoto, hasGpsIfd, MADE_UP } from '../photos/fakes';
import { anAdmin, delay, MemoryStore, PUBLIC_URL } from './fakes';

/**
 * The catalogue's content (#162, brief #154 Issue A): `[PUB-9]` the texts, saved through a typed
 * service function and published at the next publish; `[PUB-13]` each published photo a copy of
 * its stored sizes under a new random path; `[PUB-15]` rotating the token publishes under a new
 * one, then deletes and invalidates the old one, and a rotation that fails before the new snapshot
 * is written leaves the old one serving.
 */

let fresh: FreshDatabase;
const state: { db?: FreshDatabase['db'] } = {};
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

beforeAll(async () => {
  fresh = await freshDatabase();
  state.db = fresh.db;
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('update collection_item set cover_photo_id = null; delete from photo; delete from collection_item; delete from lego_set;');
  await fresh.db.update(catalogueSettings).set({ publicToken: null, publishLease: null, publishLeaseUntil: null, introText: '', contactText: '' });
});

/** The publish step over the test database, one in-memory store and a recorded invalidation. */
function step(overrides: Partial<PublishDependencies> = {}, store = new MemoryStore()) {
  const invalidations: string[][] = [];
  const { log, lines, events } = captureLogger();
  let clock = Date.parse('2026-11-02T09:00:00.000Z');
  const { publishCatalogue, rotateCatalogueToken } = createPublishStep({
    database: () => fresh.db,
    store: () => store,
    invalidate: async (paths) => void invalidations.push([...paths]),
    publicUrl: () => PUBLIC_URL,
    now: () => new Date((clock += 1000)),
    sleep: () => delay(20),
    log,
    ...overrides,
  });
  return { publish: publishCatalogue, rotate: rotateCatalogueToken, store, invalidations, lines, events };
}

async function storedToken(): Promise<string> {
  const [row] = await fresh.db.select({ publicToken: catalogueSettings.publicToken }).from(catalogueSettings);
  return row?.publicToken ?? '';
}

function catalogueIn(store: MemoryStore, token: string): PublicCatalogueData {
  return JSON.parse(Buffer.from(store.objects.get(`c/${token}/catalogue.json`)?.body ?? []).toString()) as PublicCatalogueData;
}

const storedKey = () => `photos/${randomBytes(32).toString('base64url')}.webp`;
const WEBP = sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 30, g: 60, b: 200 } } })
  .webp()
  .toBuffer()
  .then((buffer) => new Uint8Array(buffer));

/** A made-up set and an item of it, with `photos` photos in the fake photo bucket; answers their keys. */
async function anItem(
  store: MemoryStore,
  options: { setNum: string; photos?: number; cover?: number; complete?: boolean; missingNotes?: string | null; imageUrl?: string | null } = { setNum: '10001-1' },
) {
  const id = randomUUID();
  const now = new Date('2026-10-01T10:00:00.000Z');
  await fresh.db.insert(schema.legoSet).values({
    setNum: options.setNum,
    name: `Made-up set ${options.setNum}`,
    theme: 'Made-up theme',
    year: 2001,
    numParts: 123,
    imageUrl: options.imageUrl === undefined ? `https://cdn.example.test/${options.setNum}.jpg` : options.imageUrl,
    fetchedAt: now,
  });
  await fresh.db.insert(schema.collectionItem).values({
    id,
    setNum: options.setNum,
    condition: 'USED_WITH_BOX',
    complete: options.complete ?? true,
    missingNotes: options.missingNotes ?? null,
    hasInstructions: true,
    description: 'Made-up description.',
    quantity: 1,
    storageLocation: `made-up shelf ${randomBytes(4).toString('hex')}`,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const body = await WEBP;
  const photos: { id: string; fullKey: string; thumbnailKey: string }[] = [];
  for (let position = 0; position < (options.photos ?? 0); position++) {
    const row = { id: randomUUID(), fullKey: storedKey(), thumbnailKey: storedKey() };
    await fresh.db.insert(schema.photo).values({ ...row, sha256: 'a'.repeat(64), createdAt: now, itemId: id, position });
    for (const key of [row.fullKey, row.thumbnailKey]) store.photos.set(key, { body, contentType: 'image/webp', cacheControl: 'private, max-age=600', metadata: { origin: 'made-up' } });
    photos.push(row);
  }
  const cover = photos[options.cover ?? 0];
  if (cover !== undefined) await fresh.db.update(schema.collectionItem).set({ coverPhotoId: cover.id }).where(eq(schema.collectionItem.id, id));
  return { id, photos };
}


describe('the catalogue texts', () => {
  it('[PUB-9] are public columns in the registry, with a 2,000-character cap', async () => {
    expect(CLASSIFICATION.catalogue_settings?.intro_text?.visibility).toBe('public');
    expect(CLASSIFICATION.catalogue_settings?.contact_text?.visibility).toBe('public');
    await expect(fresh.db.update(catalogueSettings).set({ introText: 'x'.repeat(2_001) })).rejects.toThrow();
  });

  it('[PUB-9] are saved through a typed admin operation: trimmed, plain text, at most 2,000 characters', async () => {
    const { saveCatalogueTexts, readCatalogueTexts } = await import('../../../src/server/settings/catalogue-texts');
    const forged = { sessionKey: 'made-up', requestId: 'made-up' } as unknown as AdminContext;
    await expect(saveCatalogueTexts(forged, { introText: 'a', contactText: 'b' })).rejects.toThrow(NotAdminError);
    await expect(readCatalogueTexts(forged)).rejects.toThrow(NotAdminError);

    expect(await saveCatalogueTexts(anAdmin(), { introText: '  Made-up intro.\r\nSecond line.  ', contactText: '\tmade-up@example.test ' })).toEqual({
      introText: 'Made-up intro.\nSecond line.',
      contactText: 'made-up@example.test',
    });
    expect(await readCatalogueTexts(anAdmin())).toEqual({ introText: 'Made-up intro.\nSecond line.', contactText: 'made-up@example.test' });
    // 2,000 characters once trimmed is the most.
    await expect(saveCatalogueTexts(anAdmin(), { introText: ` ${'x'.repeat(2_000)} `, contactText: '' })).resolves.toMatchObject({ contactText: '' });
    await expect(saveCatalogueTexts(anAdmin(), { introText: 'x'.repeat(2_001), contactText: '' })).rejects.toThrow();
    await expect(saveCatalogueTexts(anAdmin(), { introText: 'a\u0000b', contactText: '' })).rejects.toThrow(/plain text/);
    await expect(saveCatalogueTexts(anAdmin(), { introText: 'a', contactText: 'b', html: true } as never)).rejects.toThrow(/unrecognized/i);
  });

  it('[PUB-9] reach the catalogue only at the next publish, as text, never as HTML', async () => {
    const { saveCatalogueTexts } = await import('../../../src/server/settings/catalogue-texts');
    const { publish, store } = step();
    await publish(anAdmin(), {});
    const token = await storedToken();
    const intro = 'Made-up <b>intro</b> & <script>alert(1)</script>';
    await saveCatalogueTexts(anAdmin(), { introText: intro, contactText: 'Write to <made-up@example.test>' });
    // Saved, not yet published.
    expect(catalogueIn(store, token).introText).toBe('');
    await publish(anAdmin(), {});
    expect(catalogueIn(store, token)).toMatchObject({ introText: intro, contactText: 'Write to <made-up@example.test>' });
    // No page carries the markup as markup, whichever renderer writes the pages.
    for (const [key, object] of store.objects) {
      if (!object.contentType.startsWith('text/html')) continue;
      const page = Buffer.from(object.body).toString();
      expect(page, key).not.toContain('<script>alert(1)</script>');
      expect(page, key).not.toContain('<b>intro</b>');
    }
  });
});

describe('the projection', () => {
  it('[PUB-13] publishes every item with its set, sorted by set number, its photos cover first, and nothing private', async () => {
    const { publish, store } = step();
    const later = await anItem(store, { setNum: '10294-1', photos: 0, complete: false, missingNotes: '  two made-up minifigures  ' });
    const earlier = await anItem(store, { setNum: '9999-1', photos: 3, cover: 2, missingNotes: 'ignored, the set is complete', imageUrl: 'http://cdn.example.test/insecure.jpg' });
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'published' });
    const token = await storedToken();
    const catalogue = catalogueIn(store, token);
    expect(catalogue.items.map(({ setNum }) => setNum)).toEqual(['9999-1', '10294-1']);
    const [first, second] = catalogue.items;
    expect(first).toMatchObject({ id: earlier.id, missingNotes: null, stockImageUrl: null, numParts: 123, theme: 'Made-up theme', year: 2001, quantity: 1 });
    expect(second).toMatchObject({ id: later.id, complete: false, missingNotes: 'two made-up minifigures', stockImageUrl: 'https://cdn.example.test/10294-1.jpg', photos: [] });
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['complete', 'condition', 'description', 'hasInstructions', 'id', 'missingNotes', 'name', 'numParts', 'photos', 'quantity', 'setNum', 'stockImageUrl', 'theme', 'year'].sort(),
    );
    // Cover first, then the others in their order; each a copy of the photo's own stored sizes.
    const sources = new Map(store.copied.map(({ from, to }) => [to.slice(`c/${token}/`.length), from]));
    const order = [earlier.photos[2], earlier.photos[0], earlier.photos[1]];
    expect(first?.photos.map(({ full, thumb }) => [sources.get(full), sources.get(thumb)])).toEqual(order.map((p) => [p?.fullKey, p?.thumbnailKey]));
    // No storage location and no stored key in any file.
    const rows = await fresh.db.select({ storageLocation: schema.collectionItem.storageLocation }).from(schema.collectionItem);
    for (const [key, object] of store.objects) {
      const text = Buffer.from(object.body).toString('latin1');
      for (const { storageLocation } of rows) expect(text.includes(storageLocation), key).toBe(false);
      for (const photo of earlier.photos) expect(text.includes(photo.fullKey.slice(7, -5)) || text.includes(photo.thumbnailKey.slice(7, -5)), key).toBe(false);
    }
  });
});

describe('the public photo copies', () => {
  it('[PUB-13] are WebP copies under the token with new random paths, the snapshot’s headers and none of the source’s', async () => {
    const { publish, store } = step();
    await anItem(store, { setNum: '10001-1', photos: 2 });
    await publish(anAdmin(), {});
    const token = await storedToken();
    expect(store.copied).toHaveLength(4);
    const paths = catalogueIn(store, token).items.flatMap(({ photos }) => photos.flatMap(({ full, thumb }) => [full, thumb]));
    expect(new Set(paths).size).toBe(4);
    for (const path of paths) {
      expect(path).toMatch(/^p\/[A-Za-z0-9_-]{43}\.webp$/);
      const copy = store.objects.get(`c/${token}/${path}`);
      expect(copy).toMatchObject({ contentType: 'image/webp', cacheControl: SNAPSHOT_CACHE_CONTROL });
      expect(copy).not.toHaveProperty('metadata');
    }
  });

  it('[PUB-13] of a photo uploaded with GPS carry no metadata, since they are the re-encoded stored sizes', async () => {
    const { publish, store } = step();
    const { photos } = await anItem(store, { setNum: '10002-1', photos: 1 });
    const upload = await gpsPhoto();
    expect(hasGpsIfd((await sharp(upload).metadata()).exif)).toBe(true);
    const sizes = await reencodePhoto(upload, { longestEdge: 2048 });
    const [row] = photos;
    store.photos.set(row?.fullKey ?? '', { body: sizes.full.body, contentType: 'image/webp', cacheControl: 'private, max-age=600' });
    store.photos.set(row?.thumbnailKey ?? '', { body: sizes.thumbnail.body, contentType: 'image/webp', cacheControl: 'private, max-age=600' });
    await publish(anAdmin(), {});
    const token = await storedToken();
    const [photo] = catalogueIn(store, token).items[0]?.photos ?? [];
    for (const path of [photo?.full, photo?.thumb]) {
      const copy = store.objects.get(`c/${token}/${path}`);
      const metadata = await sharp(copy?.body).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      const bytes = Buffer.from(copy?.body ?? []).toString('latin1');
      for (const value of [MADE_UP.make, MADE_UP.model, MADE_UP.xmpMarker]) expect(bytes).not.toContain(value);
    }
  });

  it('[PUB-13] are new at each publish, and a photo deleted since the last publish is absent from the next', async () => {
    const { publish, store } = step();
    const { photos } = await anItem(store, { setNum: '10003-1', photos: 2 });
    await publish(anAdmin(), {});
    const token = await storedToken();
    const before = new Set([...store.objects.keys()].filter((key) => key.includes('/p/')));
    expect(before.size).toBe(4);
    await fresh.db.delete(schema.photo).where(eq(schema.photo.id, photos[1]?.id ?? ''));
    await publish(anAdmin(), {});
    const after = [...store.objects.keys()].filter((key) => key.includes('/p/'));
    expect(after).toHaveLength(2);
    for (const key of after) expect(before.has(key)).toBe(false);
    // The bucket holds exactly what the catalogue names, and the pages.
    const named = catalogueIn(store, token).items.flatMap(({ photos: own }) => own.flatMap(({ full, thumb }) => [`c/${token}/${full}`, `c/${token}/${thumb}`]));
    expect(after.sort()).toEqual(named.sort());
  });

  it('[PUB-13] [OPS-6] a copy that fails leaves the previous snapshot as it was, and none of this publish’s copies', async () => {
    const { publish, store, events } = step();
    await anItem(store, { setNum: '10004-1', photos: 3 });
    await publish(anAdmin(), {});
    const before = store.snapshot();
    store.failCopy = store.copies + 4;
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(store.snapshot()).toEqual(before);
    expect(events().at(-1)).toMatchObject({ businessEvent: 'catalogue.publish.failed', stage: 'write' });
  });

  it('[PUB-13] about 1,100 copies run in parallel, bounded, and fit the server function’s time limit', { timeout: 30_000 }, async () => {
    // 140 sets with four photos of two sizes each: 1,120 copies. The fake store takes LATENCY_MS
    // per copy; a copy inside one region measured in the tens of milliseconds (brief #154, §8).
    const LATENCY_MS = 25;
    const store = new MemoryStore();
    const { publish } = step({}, store);
    for (let index = 0; index < 140; index++) await anItem(store, { setNum: `${20000 + index}-1`, photos: 4 });
    store.copyLatencyMs = LATENCY_MS;
    const started = performance.now();
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'published' });
    const elapsed = performance.now() - started;
    expect(store.copied).toHaveLength(1_120);
    expect(store.maxInFlight).toBe(WRITE_CONCURRENCY);
    // At WRITE_CONCURRENCY at a time the copies take ceil(1120 / 32) rounds of one latency each.
    const rounds = Math.ceil(1_120 / WRITE_CONCURRENCY);
    expect(elapsed).toBeGreaterThanOrEqual(rounds * LATENCY_MS * 0.9);
    // Scaled to a pessimistic 250 ms a copy, the whole publish still fits half of the 55 seconds
    // (`infra/admin.ts`). The deployed latency is measured on the first real publish.
    expect(elapsed * (250 / LATENCY_MS)).toBeLessThan(55_000 / 2);
  });
});

describe('rotateCatalogueToken', () => {
  it('[PUB-15] refuses anything but an AdminContext the session check issued, and validates its input', async () => {
    const { rotate, store } = step();
    await expect(rotate({ sessionKey: 'x', requestId: 'x' } as unknown as AdminContext, {})).rejects.toThrow(NotAdminError);
    await expect(rotate(anAdmin(), { token: 'mine' } as never)).rejects.toThrow(/unrecognized/i);
    expect(store.objects.size).toBe(0);
  });

  it('[PUB-15] makes a new token, publishes under it, then deletes every object under the old one and invalidates it', async () => {
    const { publish, rotate, store, invalidations, events, lines } = step();
    await anItem(store, { setNum: '10005-1', photos: 2 });
    await publish(anAdmin(), {});
    const old = await storedToken();
    invalidations.length = 0;
    // The settings page calls it with the admin alone.
    const result = await rotate(anAdmin('request-made-up-rotate'));
    const token = await storedToken();
    expect(isCatalogueToken(token)).toBe(true);
    expect(token).not.toBe(old);
    expect(result).toEqual({ status: 'rotated', url: `${PUBLIC_URL}/c/${token}/`, publishedAt: expect.any(String), oldRemoved: true });
    const keys = [...store.objects.keys()];
    expect(keys.filter((key) => key.startsWith(`c/${old}/`))).toEqual([]);
    expect(keys.every((key) => key.startsWith(`c/${token}/`))).toBe(true);
    expect(catalogueIn(store, token).items).toHaveLength(1);
    expect(invalidations).toEqual([[`/c/${old}/`, `/c/${old}/*`]]);
    expect(events().at(-1)).toMatchObject({ level: 'info', businessEvent: 'catalogue.token.rotated', requestId: 'request-made-up-rotate', oldRemoved: true, photos: 4 });
    for (const line of lines) {
      expect(line).not.toContain(old);
      expect(line).not.toContain(token);
    }
  });

  it('[PUB-15] [OPS-6] a rotation that fails before the new snapshot is written leaves the old one serving', async () => {
    const { publish, rotate, store, invalidations, events } = step();
    await anItem(store, { setNum: '10006-1', photos: 1 });
    await publish(anAdmin(), {});
    const old = await storedToken();
    const before = store.snapshot();
    invalidations.length = 0;
    store.failPut = store.puts + 2;
    expect(await rotate(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(await storedToken()).toBe(old);
    expect(store.snapshot()).toEqual(before);
    expect(invalidations).toEqual([]);
    expect(events().at(-1)).toMatchObject({ businessEvent: 'catalogue.publish.failed', stage: 'write', rotate: true });
  });

  it('[PUB-15] [OPS-6] a rotation whose new token can’t be stored deletes its new files and leaves the old one serving', async () => {
    const { publish, rotate, store, lines } = step();
    await anItem(store, { setNum: '10007-1', photos: 1 });
    await publish(anAdmin(), {});
    const old = await storedToken();
    const before = store.snapshot();
    await fresh.client.query(`
      create or replace function refuse_rotation() returns trigger language plpgsql as
        $$ begin raise exception 'refusing to rotate'; end $$;
      create trigger refuse_rotation before update on catalogue_settings for each row
        when (new.public_token is distinct from old.public_token) execute function refuse_rotation();
    `);
    try {
      expect(await rotate(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
      expect(await storedToken()).toBe(old);
      expect(store.snapshot()).toEqual(before);
      for (const line of lines) expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
    } finally {
      await fresh.client.query('drop trigger refuse_rotation on catalogue_settings; drop function refuse_rotation();');
    }
  });

  it('[PUB-15] says so when the old path could not be invalidated', async () => {
    const store = new MemoryStore();
    await step({}, store).publish(anAdmin(), {});
    const { rotate, events } = step(
      {
        invalidate: async () => {
          throw new Error('Rate exceeded');
        },
      },
      store,
    );
    expect(await rotate(anAdmin(), {})).toMatchObject({ status: 'rotated', oldRemoved: false });
    expect(events().at(-1)).toMatchObject({ level: 'warn', businessEvent: 'catalogue.token.rotated', oldRemoved: false });
  });

  it('[PUB-15] [PUB-8] takes the publish’s turn: it waits for a publish that is running, and writes nothing when it does not end', async () => {
    const store = new MemoryStore();
    await step({}, store).publish(anAdmin(), {});
    const old = await storedToken();
    const before = store.snapshot();
    await fresh.client.query(
      `update catalogue_settings set publish_lease = '00000000-0000-4000-8000-0000000000bb', publish_lease_until = now() + interval '1 minute'`,
    );
    const { rotate } = step({ sleep: async () => undefined }, store);
    expect(await rotate(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true, busy: true });
    expect(await storedToken()).toBe(old);
    expect(store.snapshot()).toEqual(before);
  });
});
