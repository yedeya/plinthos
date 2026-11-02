import { randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, type AdminContext } from '../../../src/server/auth/admin-context';
import { createCatalogueService } from '../../../src/server/catalogue/sets';
import { createItemService } from '../../../src/server/items/items';
import { createPhotoService } from '../../../src/server/photos/photos';
import type { PublicCatalogueData } from '../../../src/server/publish/catalogue-data';
import { createPublishStep } from '../../../src/server/publish/publish';
import { BATCH_BUDGET_MS, REPUBLISH_BUDGET_MS } from '../../../src/server/sync/limits';
import { syncMutation, syncRegistry, type SyncMutation } from '../../../src/server/sync/registry';
import { createReplay, type Republish } from '../../../src/server/sync/replay';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { madeUpSet, standInCatalogue } from '../catalogue/fakes';
import { memoryBucket, type MemoryBucket } from '../photos/fakes';
import { delay, MemoryStore, PUBLIC_URL } from '../publish/fakes';

/**
 * `[PUB-16]` (#187, security review F-1): a delete of a photo, a set or a parts overview photo
 * republishes a published catalogue, so what was deleted leaves the public site with its photo
 * copies (`[PUB-13]`, `[ITEM-5]`). Once per sync batch, however many deletes it applied; a failed
 * republish never fails the delete; no catalogue published, no publish. Every row is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let bucket: MemoryBucket;
let store: MemoryStore;
let capture: ReturnType<typeof captureLogger>;
let invalidations: string[][];

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
  await fresh.client.query('truncate applied_mutation, photo, collection_item, lego_set cascade');
  await fresh.db.update(schema.catalogueSettings).set({ publicToken: null, publishLease: null, publishLeaseUntil: null });
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  bucket = memoryBucket();
  store = new MemoryStore();
  capture = captureLogger();
  invalidations = [];
});

function publishStep() {
  return createPublishStep({
    database: () => fresh.db,
    store: () => store,
    invalidate: async (paths) => void invalidations.push([...paths]),
    publicUrl: () => PUBLIC_URL,
    sleep: () => delay(10),
    log: capture.log,
  });
}

function mutations(): SyncMutation[] {
  const catalogue = createCatalogueService({ provider: () => standInCatalogue([madeUpSet('990001-1')]).provider });
  const photos = createPhotoService({ storage: () => bucket.storage, settings: () => ({ longestEdge: 1024, maxBytes: 256 * 1024 }), log: capture.log });
  const items = createItemService({ catalogue: () => catalogue, storage: () => bucket.storage, log: capture.log });
  return [...photos.mutations, ...items.mutations];
}

/** The replay as deployed: the production mutations, republishing through the publish step. */
function replay(republish: Republish = (context) => publishStep().republishCatalogue(context), registry = mutations()) {
  return createReplay(syncRegistry(registry), { log: capture.log, republish });
}

const WEBP = sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 90, b: 20 } } })
  .webp()
  .toBuffer()
  .then((buffer) => new Uint8Array(buffer));
const storedKey = () => `photos/${randomBytes(32).toString('base64url')}.webp`;

/** A made-up set and an item of it with `photos` photos, their stored sizes in the fake photo bucket. */
async function anItem(setNum: string, photos: number): Promise<{ id: string; photoIds: string[] }> {
  const at = new Date('2026-10-01T10:00:00.000Z');
  await fresh.db.insert(schema.legoSet).values({ setNum, name: `Made-up ${setNum}`, theme: 'Made-up', year: 2001, numParts: 10, imageUrl: null, fetchedAt: at });
  const id = randomUUID();
  await fresh.db.insert(schema.collectionItem).values({
    id,
    setNum,
    condition: 'SEALED',
    complete: true,
    hasInstructions: true,
    description: 'Made-up.',
    quantity: 1,
    storageLocation: 'Made-up shelf',
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const photoIds: string[] = [];
  for (let position = 0; position < photos; position++) photoIds.push(await aPhoto({ itemId: id, position }));
  return { id, photoIds };
}

async function aPhoto(owner: { itemId: string; position: number } | { partsLot: true; position: number }): Promise<string> {
  const id = randomUUID();
  const row = { id, fullKey: storedKey(), thumbnailKey: storedKey() };
  await fresh.db.insert(schema.photo).values({ ...row, sha256: 'd'.repeat(64), createdAt: new Date(), ...owner });
  const body = await WEBP;
  for (const key of [row.fullKey, row.thumbnailKey]) store.photos.set(key, { body, contentType: 'image/webp', cacheControl: 'private, max-age=600' });
  return id;
}

async function token(): Promise<string | null> {
  const [row] = await fresh.db.select({ publicToken: schema.catalogueSettings.publicToken }).from(schema.catalogueSettings);
  return row?.publicToken ?? null;
}

function catalogue(at: string): PublicCatalogueData {
  return JSON.parse(Buffer.from(store.objects.get(`c/${at}/catalogue.json`)?.body ?? []).toString()) as PublicCatalogueData;
}

const publishes = () => capture.events().filter((event) => event.businessEvent === 'catalogue.published');
const photoCopies = () => [...store.objects.keys()].filter((key) => key.includes('/p/'));

describe('a delete while the catalogue is published', () => {
  it('[PUB-16] [PUB-13] [ITEM-5] a set deleted through the replay is absent from the next snapshot, its page and its photo copies too', async () => {
    const kept = await anItem('990001-1', 1);
    const deleted = await anItem('990002-1', 2);
    expect(await publishStep().publishCatalogue(admin, {})).toMatchObject({ status: 'published' });
    const at = (await token()) ?? '';
    expect(photoCopies()).toHaveLength(6);
    expect(store.objects.has(`c/${at}/s/${deleted.id}/index.html`) || catalogue(at).items.some(({ id }) => id === deleted.id)).toBe(true);

    const response = await replay()(admin, { mutations: [{ id: randomUUID(), name: 'deleteItem', input: { id: deleted.id } }] });
    expect(response.outcomes).toEqual([expect.objectContaining({ outcome: 'applied', result: { id: deleted.id, deleted: true, photosDeleted: 2 } })]);
    expect(response.catalogue).toBe('updated');
    expect(catalogue(at).items.map(({ id }) => id)).toEqual([kept.id]);
    expect([...store.objects.keys()].some((key) => key.includes(deleted.id))).toBe(false);
    // Only the kept item's two sizes are left, under new paths.
    expect(photoCopies()).toHaveLength(2);
    expect(publishes().at(-1)).toMatchObject({ republish: true, items: 1, photos: 2 });
  });

  it('[PUB-16] [PUB-13] a photo deleted through the replay leaves the snapshot, and so does a parts overview photo', async () => {
    const item = await anItem('990003-1', 2);
    const overview = await aPhoto({ partsLot: true, position: 0 });
    await publishStep().publishCatalogue(admin, {});
    const at = (await token()) ?? '';
    expect(catalogue(at).parts?.photos).toHaveLength(1);
    const response = await replay()(admin, {
      mutations: [
        { id: randomUUID(), name: 'deletePhoto', input: { photoId: item.photoIds[0] } },
        { id: randomUUID(), name: 'deletePhoto', input: { photoId: overview } },
      ],
    });
    expect(response.catalogue).toBe('updated');
    expect(catalogue(at).items[0]?.photos).toHaveLength(1);
    expect(catalogue(at).parts).toBeNull();
    expect(photoCopies()).toHaveLength(2);
  });

  it('[PUB-16] N deletes in one batch make one publish, after the batch', async () => {
    const a = await anItem('990004-1', 3);
    const b = await anItem('990005-1', 1);
    await publishStep().publishCatalogue(admin, {});
    invalidations.length = 0;
    const before = publishes().length;
    const response = await replay()(admin, {
      mutations: [
        ...a.photoIds.map((photoId) => ({ id: randomUUID(), name: 'deletePhoto', input: { photoId } })),
        { id: randomUUID(), name: 'deleteItem', input: { id: b.id } },
      ],
    });
    expect(response.outcomes.map(({ outcome }) => outcome)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(response.catalogue).toBe('updated');
    expect(publishes().length - before).toBe(1);
    expect(invalidations).toHaveLength(1);
  });

  it('[PUB-16] a failed republish leaves the delete applied, says the catalogue is stale and logs catalogue.republish.failed', async () => {
    const item = await anItem('990006-1', 1);
    await publishStep().publishCatalogue(admin, {});
    const at = (await token()) ?? '';
    const before = store.snapshot();
    store.failPut = store.puts + 1;
    const response = await replay()(admin, { mutations: [{ id: randomUUID(), name: 'deleteItem', input: { id: item.id } }] });
    expect(response.outcomes).toEqual([expect.objectContaining({ outcome: 'applied' })]);
    expect(response.catalogue).toBe('stale');
    expect((await fresh.client.query('select id from collection_item')).rows).toEqual([]);
    // The previous snapshot is put back whole, as a failed publish's is ([OPS-6]).
    expect(store.snapshot()).toEqual(before);
    expect(catalogue(at).items).toHaveLength(1);
    expect(capture.events()).toContainEqual(
      expect.objectContaining({ level: 'error', businessEvent: 'catalogue.republish.failed', requestId: admin.requestId, previousKept: true }),
    );
    for (const line of capture.lines) expect(line).not.toContain(at);
  });

  it('[PUB-16] a republish that throws never fails the batch', async () => {
    const item = await anItem('990007-1', 0);
    const response = await replay(async () => {
      throw new Error('made-up failure');
    })(admin, { mutations: [{ id: randomUUID(), name: 'deleteItem', input: { id: item.id } }] });
    expect(response).toEqual({ outcomes: [expect.objectContaining({ outcome: 'applied' })], catalogue: 'stale' });
    expect(capture.events()).toContainEqual(expect.objectContaining({ businessEvent: 'catalogue.republish.failed' }));
  });

  it('[PUB-16] with no catalogue published, a delete publishes nothing and makes no token', async () => {
    const item = await anItem('990008-1', 1);
    const response = await replay()(admin, { mutations: [{ id: randomUUID(), name: 'deleteItem', input: { id: item.id } }] });
    expect(response.catalogue).toBe('not-published');
    expect(await token()).toBeNull();
    expect(store.objects.size).toBe(0);
    expect(publishes()).toEqual([]);
  });

  it('[PUB-16] a batch that deleted nothing republishes nothing', async () => {
    await anItem('990009-1', 1);
    await publishStep().publishCatalogue(admin, {});
    const before = publishes().length;
    // A delete of a photo that is already gone, and no delete at all.
    expect(await replay()(admin, { mutations: [{ id: randomUUID(), name: 'deletePhoto', input: { photoId: randomUUID() } }] })).not.toHaveProperty('catalogue');
    expect(publishes().length).toBe(before);
  });

  it('[PUB-16] [SYNC-11] a batch that may delete keeps time for its republish', async () => {
    // Two made-up mutations of 12 seconds each, beside a made-up delete; the clock moves by each one's budget.
    let clock = 0;
    const slow = syncMutation({ name: 'slow', input: z.object({}).strict(), apply: async () => void (clock += 12_000), budgetMs: 12_000 });
    const remove = syncMutation({ name: 'remove', input: z.object({}).strict(), apply: async () => ({ deleted: true }), republishes: (result: { deleted: boolean }) => result.deleted });
    let republished = 0;
    const run = (names: string[]) =>
      createReplay(syncRegistry([slow, remove]), {
        log: capture.log,
        now: () => clock,
        republish: async () => {
          republished += 1;
          return { catalogue: 'updated' };
        },
      })(admin, { mutations: names.map((name) => ({ id: randomUUID(), name, input: {} })) });
    expect(BATCH_BUDGET_MS - REPUBLISH_BUDGET_MS).toBeLessThan(24_000);
    expect(BATCH_BUDGET_MS).toBeGreaterThanOrEqual(24_000);
    clock = 0;
    const withDelete = await run(['slow', 'slow', 'remove']);
    expect(withDelete.outcomes.map(({ outcome }) => outcome)).toEqual(['applied', 'not-attempted', 'not-attempted']);
    expect(republished).toBe(0);
    clock = 0;
    const without = await run(['slow', 'slow']);
    expect(without.outcomes.map(({ outcome }) => outcome)).toEqual(['applied', 'applied']);
  });
});
