import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { IDBFactory } from 'fake-indexeddb';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { itemMutations, queueItem, queueItemDeletion, type ItemDraft } from '../../../src/app/_offline/items';
import { PRESIGN_ENDPOINT } from '../../../src/app/_offline/photos';
import { openQueue } from '../../../src/app/_offline/queue';
import { replayQueue, SYNC_ENDPOINT } from '../../../src/app/_offline/replay';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, type AdminContext } from '../../../src/server/auth/admin-context';
import { createCatalogueService } from '../../../src/server/catalogue/sets';
import { createItemService, DeleteItemInput, SaveItemInput, SetItemPhotosInput } from '../../../src/server/items/items';
import { createPhotoService, DeletePhotoInput, RegisterPhotoInput } from '../../../src/server/photos/photos';
import { quarantineKey } from '../../../src/server/photos/keys';
import { syncRegistry } from '../../../src/server/sync/registry';
import { createReplay, SyncBatch } from '../../../src/server/sync/replay';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../../server/capture';
import { madeUpSet, standInCatalogue } from '../../server/catalogue/fakes';
import { memoryBucket, plainPhoto, type MemoryBucket } from '../../server/photos/fakes';

/**
 * The phone's half of set entry against the server's real half (`[ITEM-7]`, `[ITEM-8]`): what
 * the entry form queues for a new item with two photos replays from a stand-in IndexedDB through
 * the real presign, an in-memory bucket and the real sync registry over the test database, and
 * the item then lists with its cover. Also every input the client module makes, parsed by the
 * server's own schemas, so the two can't drift apart. Every set, item and photo is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const SET = madeUpSet('990101-1', { name: 'Made-up signal box' });
const S3_URL = 'https://photos.fake-s3.test/';

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let bucket: MemoryBucket;

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
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  bucket = memoryBucket();
});

function server() {
  const { log } = captureLogger();
  const catalogue = createCatalogueService({ provider: () => standInCatalogue([SET]).provider });
  const photos = createPhotoService({ storage: () => bucket.storage, settings: () => ({ longestEdge: 1024, maxBytes: 256 * 1024 }), log });
  const items = createItemService({ catalogue: () => catalogue, storage: () => bucket.storage, log });
  const replay = createReplay(syncRegistry([...photos.mutations, ...items.mutations]), { log });

  /** The presign route, S3 and the sync endpoint, as the phone reaches them. */
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = String(url);
    if (target === PRESIGN_ENDPOINT) return Response.json(await photos.presignPhotoUpload(admin, {}));
    if (target === S3_URL) {
      const form = init.body as FormData;
      const file = form.get('file') as Blob;
      bucket.upload(String(form.get('key')), new Uint8Array(await file.arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    expect(target).toBe(SYNC_ENDPOINT);
    return Response.json(await replay(admin, SyncBatch.parse(JSON.parse(String(init.body)))));
  }) as typeof globalThis.fetch;
  return { fetch, items };
}

async function draftWithPhotos(count: number): Promise<ItemDraft> {
  const photos = [];
  for (let i = 0; i < count; i++) photos.push({ kind: 'new' as const, key: randomUUID(), bytes: (await plainPhoto(40 + i, 30)).slice().buffer as ArrayBuffer });
  return {
    id: randomUUID(),
    baseVersion: null,
    kind: 'SET',
    setNum: '990101',
    name: '',
    refNo: '',
    approxParts: null,
    approxWeightG: null,
    condition: 'USED_WITH_BOX',
    complete: false,
    missingNotes: 'Made-up: one door',
    hasInstructions: true,
    description: 'Made-up description',
    quantity: 1,
    storageLocation: 'Made-up attic box 3',
    photos,
  };
}

describe('a new item entered on the phone', () => {
  it('[ITEM-7] [ITEM-8] syncs with its two photos through the real registry, linked in order, and lists with its first photo as the cover', async () => {
    const { fetch, items } = server();
    const queue = await openQueue(new IDBFactory());
    const draft = await draftWithPhotos(2);
    await queueItem(queue, draft);

    expect(await replayQueue(queue, { fetch })).toMatchObject({ status: 'synced', applied: 3, pending: 0 });

    const photos = (await fresh.client.query('select id, position, thumbnail_key from photo where item_id = $1 order by position', [draft.id])).rows as { id: string; position: number; thumbnail_key: string }[];
    expect(photos.map((photo) => photo.position)).toEqual([0, 1]);
    const listed = await items.listItems(admin);
    expect(listed).toEqual([expect.objectContaining({ id: draft.id, setNum: '990101-1', name: 'Made-up signal box', condition: 'USED_WITH_BOX', quantity: 1, coverThumbnailKey: photos[0]?.thumbnail_key, version: 1 })]);
    const item = await items.getItem(admin, draft.id);
    expect(item).toMatchObject({ coverPhotoId: photos[0]?.id, missingNotes: 'Made-up: one door', storageLocation: 'Made-up attic box 3' });
    queue.close();
  });

  it('[ITEM-7] an edit that reorders the stored photos and adds one syncs to the order the form showed, the first photo the cover', async () => {
    const { fetch, items } = server();
    const queue = await openQueue(new IDBFactory());
    const draft = await draftWithPhotos(2);
    await queueItem(queue, draft);
    await replayQueue(queue, { fetch });
    const before = await items.getItem(admin, draft.id);
    const [first, second] = before?.photos.map((photo) => photo.id) ?? [];
    if (first === undefined || second === undefined) throw new Error('no photos');

    const [added] = (await draftWithPhotos(1)).photos;
    if (added === undefined) throw new Error('no photo');
    const edit: ItemDraft = { ...draft, baseVersion: before?.version ?? 1, quantity: 2, photos: [{ kind: 'stored', key: second, id: second }, { kind: 'stored', key: first, id: first }, added] };
    await queueItem(queue, edit, { photoIds: [first, second], coverId: first });
    expect(await replayQueue(queue, { fetch })).toMatchObject({ status: 'synced', pending: 0 });

    const after = await items.getItem(admin, draft.id);
    expect(after?.photos.map((photo) => photo.id).slice(0, 2)).toEqual([second, first]);
    expect(after?.photos).toHaveLength(3);
    expect(after).toMatchObject({ coverPhotoId: second, quantity: 2, version: 2 });

    await queueItemDeletion(queue, draft.id);
    expect(await replayQueue(queue, { fetch })).toMatchObject({ status: 'synced', pending: 0 });
    expect(await items.listItems(admin)).toEqual([]);
    queue.close();
  });

  it('[ITEM-7] [SYNC-8] discarding an edit held as a conflict applies none of it: its photo stays, its new photo never arrives, and a later edit still syncs', async () => {
    const { fetch, items } = server();
    const phone = await openQueue(new IDBFactory());
    const draft = await draftWithPhotos(2);
    await queueItem(phone, draft);
    await replayQueue(phone, { fetch });
    const [kept, removed] = (await items.getItem(admin, draft.id))?.photos.map((photo) => photo.id) ?? [];
    if (kept === undefined || removed === undefined) throw new Error('no photos');
    const removedFiles = (await fresh.client.query('select full_key, thumbnail_key from photo where id = $1', [removed])).rows[0] as { full_key: string; thumbnail_key: string };

    // Another device changes the item first, so this phone's edit is made against a stale version.
    const other = await openQueue(new IDBFactory());
    await queueItem(other, { ...draft, baseVersion: 1, quantity: 5, photos: [{ kind: 'stored', key: kept, id: kept }, { kind: 'stored', key: removed, id: removed }] }, { photoIds: [kept, removed], coverId: kept });
    await replayQueue(other, { fetch });

    const [added] = (await draftWithPhotos(1)).photos;
    if (added === undefined) throw new Error('no photo');
    const stale = await queueItem(phone, { ...draft, baseVersion: 1, quantity: 2, photos: [{ kind: 'stored', key: kept, id: kept }, added] }, { photoIds: [kept, removed], coverId: kept });
    const later = await queueItem(phone, { ...draft, baseVersion: 2, quantity: 7, photos: [{ kind: 'stored', key: kept, id: kept }, { kind: 'stored', key: removed, id: removed }] }, { photoIds: [kept, removed], coverId: kept });
    expect(stale.map((entry) => entry.name)).toEqual(['saveItem', 'deletePhoto', 'registerPhoto']);

    expect(await replayQueue(phone, { fetch })).toMatchObject({ status: 'held' });
    const [held] = await phone.entries();
    expect(held?.held).toMatchObject({ outcome: 'conflict', reason: 'version' });
    expect((await phone.discardGroup(held?.id ?? '')).map((entry) => entry.id)).toEqual(stale.map((entry) => entry.id));
    expect((await phone.entries()).map((entry) => entry.id)).toEqual(later.map((entry) => entry.id));

    expect(await replayQueue(phone, { fetch })).toMatchObject({ status: 'synced', pending: 0 });
    const after = await items.getItem(admin, draft.id);
    expect(after?.photos.map((photo) => photo.id)).toEqual([kept, removed]);
    expect(after).toMatchObject({ quantity: 7, version: 3 });
    expect(bucket.objects.has(removedFiles.full_key) && bucket.objects.has(removedFiles.thumbnail_key)).toBe(true);
    phone.close();
    other.close();
  });

  it('[ITEM-7] [ITEM-4] [SYNC-8] discarding a new item held as unknown-set stores none of its photos', async () => {
    const { fetch, items } = server();
    const phone = await openQueue(new IDBFactory());
    const draft = { ...(await draftWithPhotos(2)), setNum: '990999-1' };
    await queueItem(phone, draft);
    expect(await replayQueue(phone, { fetch })).toMatchObject({ status: 'held' });
    const [held] = await phone.entries();
    expect(held?.held).toMatchObject({ outcome: 'invalid', code: 'unknown-set' });

    expect(await phone.discardGroup(held?.id ?? '')).toHaveLength(3);
    expect(await replayQueue(phone, { fetch })).toMatchObject({ status: 'synced', applied: 0, pending: 0 });
    expect((await fresh.client.query('select count(*)::int as n from photo')).rows[0]).toEqual({ n: 0 });
    expect(await items.listItems(admin)).toEqual([]);
    phone.close();
  });

  it('[ITEM-10] [ITEM-7] a minifigure, a bulk lot and another item entered offline sync through the real registry, with no set lookup, and list under their own names', async () => {
    const { fetch, items } = server();
    const queue = await openQueue(new IDBFactory());
    const base = await draftWithPhotos(0);
    const figure: ItemDraft = { ...base, id: randomUUID(), kind: 'MINIFIG', setNum: '', name: 'Made-up pirate captain', refNo: 'mu0001', complete: null, hasInstructions: null, missingNotes: '' };
    const bulk: ItemDraft = { ...(await draftWithPhotos(1)), kind: 'BULK', setNum: '', name: 'Made-up mixed bricks', approxParts: 2500, approxWeightG: 3200, complete: false, missingNotes: 'Made-up: unsorted' };
    const thing: ItemDraft = { ...base, id: randomUUID(), kind: 'OTHER', setNum: '', name: 'Made-up keychain', complete: true, hasInstructions: false };
    for (const draft of [figure, bulk, thing]) await queueItem(queue, draft);

    expect(await replayQueue(queue, { fetch })).toMatchObject({ status: 'synced', applied: 4, pending: 0 });
    expect((await fresh.client.query('select count(*)::int as n from lego_set')).rows[0]).toEqual({ n: 0 });
    const listed = await items.listItems(admin);
    expect(listed.map(({ id, kind, setNum, name, refNo }) => ({ id, kind, setNum, name, refNo }))).toEqual([
      { id: thing.id, kind: 'OTHER', setNum: null, name: 'Made-up keychain', refNo: null },
      { id: bulk.id, kind: 'BULK', setNum: null, name: 'Made-up mixed bricks', refNo: null },
      { id: figure.id, kind: 'MINIFIG', setNum: null, name: 'Made-up pirate captain', refNo: 'mu0001' },
    ]);
    expect(listed.find(({ id }) => id === bulk.id)?.coverThumbnailKey).toEqual(expect.any(String));
    expect(await items.getItem(admin, bulk.id)).toMatchObject({ approxParts: 2500, approxWeightG: 3200, complete: false, missingNotes: 'Made-up: unsorted', hasInstructions: true });
    expect(await items.getItem(admin, figure.id)).toMatchObject({ complete: null, hasInstructions: null, set: null });
    queue.close();
  });

  it('[ITEM-7] makes only inputs the server’s own schemas accept', async () => {
    const draft = await draftWithPhotos(2);
    const stored = [randomUUID(), randomUUID()];
    const forms = [
      await itemMutations(draft),
      // Every kind (#202): a bulk lot with its two numbers, a minifigure and another item with their yes/no fields unstated.
      await itemMutations({ ...draft, kind: 'BULK', setNum: '', name: 'Made-up bricks', refNo: ' ', approxParts: 3, approxWeightG: null }),
      await itemMutations({ ...draft, kind: 'MINIFIG', setNum: '', name: 'Made-up figure', refNo: 'mu0002', complete: null, hasInstructions: null }),
      await itemMutations({ ...draft, kind: 'OTHER', setNum: '', name: 'Made-up book', complete: false, approxParts: 4 }),
      await itemMutations({ ...draft, complete: true, baseVersion: 3, photos: [{ kind: 'stored', key: stored[1] ?? '', id: stored[1] ?? '' }, { kind: 'stored', key: stored[0] ?? '', id: stored[0] ?? '' }, ...draft.photos] }, { photoIds: [...stored, randomUUID()], coverId: stored[0] ?? null }),
    ];
    const names = new Set<string>();
    for (const mutation of forms.flat()) {
      names.add(mutation.name);
      const schemaFor = { saveItem: SaveItemInput, setItemPhotos: SetItemPhotosInput, deleteItem: DeleteItemInput, registerPhoto: RegisterPhotoInput, deletePhoto: DeletePhotoInput }[mutation.name];
      if (schemaFor === undefined) throw new Error(`unexpected ${mutation.name}`);
      const input = mutation.name === 'registerPhoto' ? { ...(mutation.input as object), quarantineKey: quarantineKey() } : mutation.input;
      expect(schemaFor.safeParse(input).error, mutation.name).toBeUndefined();
    }
    expect([...names].sort()).toEqual(['deletePhoto', 'registerPhoto', 'saveItem', 'setItemPhotos']);
    expect(DeleteItemInput.safeParse({ id: draft.id }).success).toBe(true);
  });
});
