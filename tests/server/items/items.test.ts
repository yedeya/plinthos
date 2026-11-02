import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createCatalogueService } from '../../../src/server/catalogue/sets';
import { createItemService, ITEM_REFUSALS, ItemVersionConflict, SET_LOOKUP_BUDGET_MS } from '../../../src/server/items/items';
import { createPhotoService } from '../../../src/server/photos/photos';
import { MUTATIONS } from '../../../src/server/sync/mutations';
import { syncMutation, syncRegistry, type SyncMutation } from '../../../src/server/sync/registry';
import { createReplay, type MutationOutcome } from '../../../src/server/sync/replay';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { CatalogueUnavailable, madeUpSet, standInCatalogue, type StandInCatalogue } from '../catalogue/fakes';
import { memoryBucket, plainPhoto, sha256, type MemoryBucket } from '../photos/fakes';

/**
 * The items through the offline-sync replay, as the deployed endpoint runs them, over the test
 * database, an in-memory photo bucket and a stand-in set catalogue ([ITEM-1] to [ITEM-6], #124).
 * Every set, item and photo here is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const SET_A = madeUpSet('990001-1', { name: 'Made-up lighthouse' });
const SET_B = madeUpSet('990002-1', { name: 'Made-up harbour crane' });

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let bucket: MemoryBucket;
let stand: StandInCatalogue;
let capture: ReturnType<typeof captureLogger>;

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
  stand = standInCatalogue([SET_A, SET_B]);
  capture = captureLogger();
});

function services() {
  const catalogue = createCatalogueService({ provider: () => stand.provider });
  const photos = createPhotoService({ storage: () => bucket.storage, settings: () => ({ longestEdge: 1024, maxBytes: 256 * 1024 }), log: capture.log });
  const items = createItemService({ catalogue: () => catalogue, storage: () => bucket.storage, log: capture.log });
  return { catalogue, photos, items };
}

function replay(mutations?: readonly SyncMutation[]) {
  const { photos, items } = services();
  return createReplay(syncRegistry(mutations ?? [...photos.mutations, ...items.mutations]), { log: capture.log });
}

async function one(mutation: Record<string, unknown>, run = replay()): Promise<MutationOutcome> {
  const { outcomes } = await run(admin, { mutations: [{ id: randomUUID(), ...mutation }] });
  const [outcome] = outcomes;
  if (outcome === undefined) throw new Error('no outcome');
  return outcome;
}

function itemInput(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    setNum: SET_A.setNum,
    condition: 'USED_WITH_BOX' as const,
    complete: true,
    hasInstructions: true,
    description: 'Made-up description: slight box wear.',
    quantity: 1,
    storageLocation: 'Made-up shelf 3',
    ...overrides,
  };
}

/** Queues a saveItem as the phone does: the base version in the input and in the envelope. */
const save = (input: Record<string, unknown>, baseVersion: number | null = null, run?: ReturnType<typeof replay>) =>
  one({ name: 'saveItem', input: { ...input, baseVersion }, baseVersion }, run);

async function rows(table: string): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query(`select * from ${table}`)).rows as Record<string, unknown>[];
}

async function itemRow(id: string): Promise<Record<string, unknown> | undefined> {
  return (await fresh.client.query('select * from collection_item where id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
}

/** Uploads a made-up photo to the quarantine and registers it through the replay, for an item or none. */
async function addPhoto(itemId?: string, extra: Record<string, unknown> = {}, width = 40): Promise<string> {
  const bytes = await plainPhoto(width, 30);
  const presigned = await services().photos.presignPhotoUpload(admin, {});
  bucket.upload(presigned.key, bytes);
  const outcome = await one({ name: 'registerPhoto', input: { quarantineKey: presigned.key, sha256: sha256(bytes), ...(itemId === undefined ? {} : { itemId }), ...extra } });
  expect(outcome.outcome).toBe('applied');
  return (outcome as { result: { photoId: string } }).result.photoId;
}

async function photosOf(itemId: string): Promise<{ id: string; position: number | null }[]> {
  return (await fresh.client.query('select id, position from photo where item_id = $1 order by position nulls last, created_at', [itemId])).rows as {
    id: string;
    position: number | null;
  }[];
}

describe('an item is a classified, client-keyed record', () => {
  it('[ITEM-1] stores an item under the client’s UUID with every field, version 1 and its times', async () => {
    const input = itemInput({ complete: false, missingNotes: 'Made-up: two 1x2 plates', condition: 'SEALED', quantity: 3 });
    const outcome = await save(input);
    expect(outcome).toMatchObject({ outcome: 'applied', result: { id: input.id, version: 1, setNum: SET_A.setNum, created: true } });
    const row = await itemRow(input.id);
    expect(row).toMatchObject({
      id: input.id,
      set_num: SET_A.setNum,
      condition: 'SEALED',
      complete: false,
      missing_notes: 'Made-up: two 1x2 plates',
      has_instructions: true,
      description: input.description,
      quantity: 3,
      storage_location: 'Made-up shelf 3',
      cover_photo_id: null,
      version: 1,
    });
    expect(row?.created_at).toBeInstanceOf(Date);
    expect(row?.updated_at).toEqual(row?.created_at);
  });

  it('[ITEM-1] refuses a condition, a quantity, a description or a storage location out of bounds, and an id that is not a UUID', async () => {
    const bad = [
      { condition: 'MINT' },
      { quantity: 0 },
      { quantity: 1000 },
      { quantity: 1.5 },
      { description: 'x'.repeat(2001) },
      { storageLocation: 'x'.repeat(201) },
      { id: 'not-a-uuid' },
    ];
    for (const overrides of bad) {
      expect((await save(itemInput(overrides))).outcome, JSON.stringify(overrides).slice(0, 40)).toBe('invalid');
    }
    for (const overrides of [{ quantity: 999 }, { description: 'x'.repeat(2000), storageLocation: 'x'.repeat(200) }]) {
      expect((await save(itemInput(overrides))).outcome).toBe('applied');
    }
    expect(await rows('collection_item')).toHaveLength(2);
  });

  it('[ITEM-1] keeps no missing note for a complete item', async () => {
    const input = itemInput({ complete: true, missingNotes: 'Made-up note' });
    await save(input);
    expect((await itemRow(input.id))?.missing_notes).toBeNull();
  });
});

describe('saveItem and deleteItem are typed, registered service functions', () => {
  it('[ITEM-2] are registered in the production registry with setItemPhotos, and only saveItem is versioned', () => {
    expect(MUTATIONS.get('saveItem')?.currentVersion).toBeTypeOf('function');
    expect(MUTATIONS.get('deleteItem')?.currentVersion).toBeUndefined();
    expect(MUTATIONS.get('setItemPhotos')?.currentVersion).toBeUndefined();
    expect(MUTATIONS.has('registerPhoto')).toBe(true);
  });

  it('[ITEM-2] refuse a context the session check did not issue, before they read or write anything', async () => {
    const forged = { sessionKey: randomUUID(), requestId: randomUUID() } as unknown as AdminContext;
    const { items } = services();
    await expect(items.saveItem(forged, { ...itemInput(), baseVersion: null })).rejects.toThrow(NotAdminError);
    await expect(items.deleteItem(forged, { id: randomUUID() })).rejects.toThrow(NotAdminError);
    await expect(items.setItemPhotos(forged, { itemId: randomUUID(), photoIds: [] })).rejects.toThrow(NotAdminError);
    await expect(items.listItems(forged)).rejects.toThrow(NotAdminError);
    await expect(items.getItem(forged, randomUUID())).rejects.toThrow(NotAdminError);
    expect(stand.calls).toEqual([]);
  });

  it('[ITEM-2] validate their input with zod when called directly, as the admin UI would', async () => {
    const { items } = services();
    await expect(items.saveItem(admin, { ...itemInput({ quantity: -1 }), baseVersion: null })).rejects.toThrow();
    await expect(items.deleteItem(admin, { id: 'nope' })).rejects.toThrow();
    expect(await rows('collection_item')).toEqual([]);
  });
});

describe('the version rule', () => {
  it('[ITEM-3] [SYNC-3] an update against the current version applies and moves the version on', async () => {
    const input = itemInput();
    await save(input);
    const outcome = await save({ ...input, quantity: 2, condition: 'USED_NO_BOX' }, 1);
    expect(outcome).toMatchObject({ outcome: 'applied', result: { version: 2, created: false } });
    expect(await itemRow(input.id)).toMatchObject({ quantity: 2, condition: 'USED_NO_BOX', version: 2 });
  });

  it('[ITEM-3] [SYNC-3] a stale version is a conflict answered with the server’s item, and changes nothing', async () => {
    const input = itemInput();
    await save(input);
    await save({ ...input, quantity: 2 }, 1);
    const stale = await save({ ...input, quantity: 5 }, 1);
    expect(stale).toMatchObject({ outcome: 'conflict', reason: 'version', currentVersion: 2, current: { id: input.id, quantity: 2, version: 2 } });
    expect(await itemRow(input.id)).toMatchObject({ quantity: 2, version: 2 });
    expect(capture.events().some((event) => event.businessEvent === 'sync.conflict')).toBe(true);
  });

  it('[ITEM-3] takes the base version from the input: the envelope may leave it out, never contradict it', async () => {
    const input = itemInput();
    expect(await one({ name: 'saveItem', input: { ...input, baseVersion: null } })).toMatchObject({ outcome: 'applied' });
    expect(await one({ name: 'saveItem', input: { ...input, quantity: 2, baseVersion: 1 }, baseVersion: null })).toMatchObject({ outcome: 'invalid' });
    expect(await one({ name: 'saveItem', input: { ...input, quantity: 2, baseVersion: 1 } })).toMatchObject({ outcome: 'applied', result: { version: 2 } });
  });

  it('[ITEM-3] a direct call keeps the rule: an update of another version throws and changes nothing', async () => {
    const input = itemInput();
    const { items } = services();
    await items.saveItem(admin, { ...input, baseVersion: null });
    await expect(items.saveItem(admin, { ...input, quantity: 9, baseVersion: 4 })).rejects.toThrow(ItemVersionConflict);
    await expect(items.saveItem(admin, { ...input, quantity: 9, baseVersion: null })).rejects.toThrow();
    expect((await itemRow(input.id))?.quantity).toBe(1);
  });

  it('[ITEM-3] a second create of the same item id is a version conflict, never an overwrite', async () => {
    const input = itemInput();
    await save(input);
    const again = await save({ ...input, quantity: 7 });
    expect(again).toMatchObject({ outcome: 'conflict', reason: 'version', currentVersion: 1 });
    expect((await itemRow(input.id))?.quantity).toBe(1);
  });

  it('[ITEM-3] [SYNC-3] two creates of one item that race past the version check: the key refuses the second, answered as a version conflict, not failed', async () => {
    const { photos, items } = services();
    const saveEntry = items.mutations.find((mutation) => mutation.name === 'saveItem');
    const check = saveEntry?.currentVersion;
    if (saveEntry === undefined || check === undefined) throw new Error('saveItem is not versioned');
    // Both creates read "no item" before either inserts: the race `for update` cannot lock.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothChecked = new Promise<void>((resolve) => (release = resolve));
    const racing = syncMutation({
      ...saveEntry,
      currentVersion: async (input: { id: string }) => {
        const current = await check(input);
        arrived += 1;
        if (arrived === 2) release();
        if (arrived <= 2) await bothChecked;
        return current;
      },
    } as SyncMutation);
    const run = createReplay(syncRegistry([...photos.mutations, racing, ...items.mutations.filter((m) => m.name !== 'saveItem')]), { log: capture.log });
    const id = randomUUID();
    const outcomes = await Promise.all([save(itemInput({ id, quantity: 1 }), null, run), save(itemInput({ id, quantity: 2 }), null, run)]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['applied', 'conflict']);
    const conflict = outcomes.find((outcome) => outcome.outcome === 'conflict');
    expect(conflict).toMatchObject({ reason: 'version', currentVersion: 1 });
    const winner = outcomes.find((outcome) => outcome.outcome === 'applied');
    const row = await itemRow(id);
    expect(row?.version).toBe(1);
    expect((conflict as { current: { quantity: number } }).current.quantity).toBe(row?.quantity);
    expect(winner).toBeDefined();
    // The loser recorded nothing, so the phone holds it rather than taking it as applied.
    expect(await rows('applied_mutation')).toHaveLength(1);
    expect(capture.events().some((event) => event.businessEvent === 'sync.mutation.failed')).toBe(false);
  });
});

describe('the set an item names', () => {
  it('[ITEM-4] [CAT-3] looks up a set the table doesn’t hold, inside its own budget, and stores it with the item', async () => {
    const input = itemInput({ setNum: SET_B.setNum });
    expect((await save(input)).outcome).toBe('applied');
    expect(stand.calls).toEqual([`getSet ${SET_B.setNum}`]);
    expect(stand.budgets).toEqual([SET_LOOKUP_BUDGET_MS]);
    expect(await rows('lego_set')).toEqual([expect.objectContaining({ set_num: SET_B.setNum, name: SET_B.name })]);
    // A set the table holds is not looked up again.
    await save(itemInput({ setNum: SET_B.setNum }));
    expect(stand.calls).toHaveLength(1);
  });

  it('[ITEM-4] normalizes a set number typed without its variant: 990001 is stored and shown as 990001-1', async () => {
    const input = itemInput({ setNum: '  990001 ' });
    expect(await save(input)).toMatchObject({ outcome: 'applied', result: { setNum: '990001-1' } });
    expect(stand.calls).toEqual(['getSet 990001-1']);
    expect((await itemRow(input.id))?.set_num).toBe('990001-1');
    expect((await services().items.getItem(admin, input.id))?.setNum).toBe('990001-1');
  });

  it('[ITEM-4] refuses a set number the catalogue doesn’t know as unknown-set, and stores nothing', async () => {
    const outcome = await save(itemInput({ setNum: '999999-9' }));
    expect(outcome).toMatchObject({ outcome: 'invalid', code: ITEM_REFUSALS.unknownSet });
    expect(await rows('collection_item')).toEqual([]);
    expect(await rows('lego_set')).toEqual([]);
    expect(await rows('applied_mutation')).toEqual([]);
  });

  it('[ITEM-4] [SYNC-4] a catalogue that can’t answer makes the mutation failed, so the phone retries it, and stores nothing until then', async () => {
    stand.failWith = new CatalogueUnavailable('timeout');
    const input = itemInput({ setNum: SET_B.setNum });
    const mutationId = randomUUID();
    const run = replay();
    const first = await run(admin, { mutations: [{ id: mutationId, name: 'saveItem', input: { ...input, baseVersion: null }, baseVersion: null }] });
    expect(first.outcomes[0]).toMatchObject({ outcome: 'failed' });
    expect(await rows('collection_item')).toEqual([]);
    expect(await rows('applied_mutation')).toEqual([]);
    expect(capture.events().find((event) => event.businessEvent === 'sync.mutation.failed')).toMatchObject({ mutationId });
    // The retry, once the catalogue is back, applies under the same id.
    stand.failWith = undefined;
    const retry = await run(admin, { mutations: [{ id: mutationId, name: 'saveItem', input: { ...input, baseVersion: null }, baseVersion: null }] });
    expect(retry.outcomes[0]).toMatchObject({ outcome: 'applied' });
  });

  it('[ITEM-4] never stores an item without its set’s catalogue row: the key refuses one', async () => {
    await expect(
      fresh.client.query(
        `insert into collection_item (id, set_num, condition, complete, has_instructions, description, quantity, storage_location, version, created_at, updated_at)
         values ($1, 'no-such-set-1', 'SEALED', true, true, '', 1, '', 1, now(), now())`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('deleting an item', () => {
  it('[ITEM-5] deletes the item and every photo linked to it, then their stored files once that has committed', async () => {
    const input = itemInput();
    await save(input);
    await addPhoto(input.id);
    await addPhoto(input.id, {}, 41);
    const unlinked = await addPhoto();
    expect(bucket.objects.size).toBe(6);
    const seen: { items: number; photos: number }[] = [];
    bucket.beforeChange = async () => {
      seen.push({
        items: (await fresh.client.query('select 1 from collection_item')).rowCount ?? 0,
        photos: (await fresh.client.query('select 1 from photo')).rowCount ?? 0,
      });
    };
    const outcome = await one({ name: 'deleteItem', input: { id: input.id } });
    expect(outcome).toMatchObject({ outcome: 'applied', result: { id: input.id, deleted: true, photosDeleted: 2 } });
    // Every file was moved after the rows were gone for good.
    expect(seen).toEqual([0, 1, 2, 3].map(() => ({ items: 0, photos: 1 })));
    expect(await rows('collection_item')).toEqual([]);
    expect((await rows('photo')).map((row) => row.id)).toEqual([unlinked]);
    // The item's four stored sizes moved to the trash; the unlinked photo's two stay ([PHOTO-9]).
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((key) => key.startsWith('photos/'))).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith('trash/'))).toHaveLength(4);
    // Deleting it again changes nothing.
    expect(await one({ name: 'deleteItem', input: { id: input.id } })).toMatchObject({ outcome: 'applied', result: { deleted: false } });
  });

  it('[ITEM-5] a stored file that can’t be deleted is logged and changes no outcome', async () => {
    const input = itemInput();
    await save(input);
    await addPhoto(input.id);
    bucket.beforeChange = async () => {
      throw new Error('made-up S3 failure');
    };
    expect(await one({ name: 'deleteItem', input: { id: input.id } })).toMatchObject({ outcome: 'applied', result: { deleted: true } });
    expect(capture.events().filter((event) => event.businessEvent === 'photo.cleanup.failed')).toHaveLength(2);
    expect(await rows('photo')).toEqual([]);
  });
});

describe('an item’s photos, their order and the cover', () => {
  it('[ITEM-6] registerPhoto links a photo to an item that exists, in order, and the first photo is the cover', async () => {
    const input = itemInput();
    await save(input);
    const first = await addPhoto(input.id);
    const second = await addPhoto(input.id, {}, 41);
    expect(await photosOf(input.id)).toEqual([
      { id: first, position: 0 },
      { id: second, position: 1 },
    ]);
    expect((await itemRow(input.id))?.cover_photo_id).toBe(first);
  });

  it('[ITEM-6] registerPhoto stores a photo for an item that doesn’t exist unlinked, and a photo with no item as before', async () => {
    const orphan = await addPhoto(randomUUID());
    const plain = await addPhoto();
    const stored = await rows('photo');
    expect(stored.map((row) => [row.id, row.item_id, row.position]).sort()).toEqual([[orphan, null, null], [plain, null, null]].sort());
  });

  it('[ITEM-6] registerPhoto takes the position the phone gave', async () => {
    const input = itemInput();
    await save(input);
    const later = await addPhoto(input.id, { position: 5 });
    const earlier = await addPhoto(input.id, { position: 2 }, 41);
    expect((await photosOf(input.id)).map((row) => row.id)).toEqual([earlier, later]);
    // The cover is the first photo registered, until the owner picks another.
    expect((await itemRow(input.id))?.cover_photo_id).toBe(later);
  });

  it('[ITEM-6] setItemPhotos sets the order and the cover; one it leaves out keeps its place after the listed ones', async () => {
    const input = itemInput();
    await save(input);
    const [a, b, c] = [await addPhoto(input.id), await addPhoto(input.id, {}, 41), await addPhoto(input.id, {}, 42)];
    const outcome = await one({ name: 'setItemPhotos', input: { itemId: input.id, photoIds: [c, a], coverPhotoId: a } });
    expect(outcome).toMatchObject({ outcome: 'applied', result: { photoIds: [c, a, b], coverPhotoId: a } });
    expect(await photosOf(input.id)).toEqual([
      { id: c, position: 0 },
      { id: a, position: 1 },
      { id: b, position: 2 },
    ]);
    expect((await itemRow(input.id))?.cover_photo_id).toBe(a);
    // Without a cover, the first photo in the new order is the cover.
    await one({ name: 'setItemPhotos', input: { itemId: input.id, photoIds: [b, c, a] } });
    expect((await itemRow(input.id))?.cover_photo_id).toBe(b);
  });

  it('[ITEM-6] setItemPhotos refuses a photo that isn’t the item’s, as order or as cover, and changes nothing', async () => {
    const mine = itemInput();
    const other = itemInput({ setNum: SET_B.setNum });
    await save(mine);
    await save(other);
    const own = await addPhoto(mine.id);
    const theirs = await addPhoto(other.id, {}, 41);
    const loose = await addPhoto(undefined, {}, 42);
    for (const input of [
      { itemId: mine.id, photoIds: [own, theirs] },
      { itemId: mine.id, photoIds: [loose] },
      { itemId: mine.id, photoIds: [own], coverPhotoId: theirs },
    ]) {
      expect(await one({ name: 'setItemPhotos', input })).toMatchObject({ outcome: 'invalid', code: ITEM_REFUSALS.notTheItemsPhoto });
    }
    expect(await one({ name: 'setItemPhotos', input: { itemId: randomUUID(), photoIds: [] } })).toMatchObject({ outcome: 'invalid', code: ITEM_REFUSALS.unknownItem });
    expect((await itemRow(mine.id))?.cover_photo_id).toBe(own);
    expect((await rows('photo')).find((row) => row.id === theirs)?.item_id).toBe(other.id);
  });

  it('[ITEM-6] deleting the cover makes the next photo the cover, the first when it was the last, and none when it was the only one', async () => {
    const input = itemInput();
    await save(input);
    const [a, b, c] = [await addPhoto(input.id), await addPhoto(input.id, {}, 41), await addPhoto(input.id, {}, 42)];
    await one({ name: 'setItemPhotos', input: { itemId: input.id, photoIds: [a, b, c], coverPhotoId: b } });
    await one({ name: 'deletePhoto', input: { photoId: b } });
    expect((await itemRow(input.id))?.cover_photo_id).toBe(c);
    await one({ name: 'deletePhoto', input: { photoId: c } });
    expect((await itemRow(input.id))?.cover_photo_id).toBe(a);
    // Deleting a photo that is not the cover leaves the cover alone.
    const d = await addPhoto(input.id, {}, 43);
    await one({ name: 'deletePhoto', input: { photoId: d } });
    expect((await itemRow(input.id))?.cover_photo_id).toBe(a);
    await one({ name: 'deletePhoto', input: { photoId: a } });
    expect((await itemRow(input.id))?.cover_photo_id).toBeNull();
  });

  it('[ITEM-6] an edit of the item after its photos is no conflict: photos never move its version', async () => {
    const input = itemInput();
    await save(input);
    const photo = await addPhoto(input.id);
    await one({ name: 'setItemPhotos', input: { itemId: input.id, photoIds: [photo] } });
    expect(await save({ ...input, quantity: 4 }, 1)).toMatchObject({ outcome: 'applied', result: { version: 2 } });
  });
});

describe('reading items', () => {
  it('[ITEM-6] listItems answers newest first with the set’s name and the cover’s thumbnail key, and filters by set number or name', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const catalogue = createCatalogueService({ provider: () => stand.provider });
    const items = createItemService({ catalogue: () => catalogue, storage: () => bucket.storage, now: () => new Date((clock += 1000)) });
    const older = itemInput({ setNum: SET_A.setNum });
    const newer = itemInput({ setNum: SET_B.setNum, quantity: 2 });
    const run = createReplay(syncRegistry([...services().photos.mutations, ...items.mutations]), { log: capture.log });
    await save(older, null, run);
    await save(newer, null, run);
    const cover = await addPhoto(older.id);
    const thumbnailKey = (await rows('photo')).find((row) => row.id === cover)?.thumbnail_key;

    const listed = await items.listItems(admin);
    expect(listed.map((item) => item.id)).toEqual([newer.id, older.id]);
    expect(listed[1]).toMatchObject({ setNum: SET_A.setNum, name: SET_A.name, condition: 'USED_WITH_BOX', quantity: 1, coverThumbnailKey: thumbnailKey, version: 1 });
    expect(listed[0]?.coverThumbnailKey).toBeNull();
    expect(JSON.stringify(listed)).not.toContain('Made-up shelf');

    expect((await items.listItems(admin, { filter: 'crane' })).map((item) => item.id)).toEqual([newer.id]);
    expect((await items.listItems(admin, { filter: '990001' })).map((item) => item.id)).toEqual([older.id]);
    expect(await items.listItems(admin, { filter: '%' })).toEqual([]);
  });

  it('[ITEM-6] getItem answers the item with its set and its photos in order, and null for one that doesn’t exist', async () => {
    const input = itemInput();
    await save(input);
    const a = await addPhoto(input.id);
    const b = await addPhoto(input.id, {}, 41);
    const { items } = services();
    const item = await items.getItem(admin, input.id);
    expect(item).toMatchObject({ id: input.id, set: SET_A, storageLocation: 'Made-up shelf 3', coverPhotoId: a, version: 1 });
    expect(item?.photos.map((photo) => photo.id)).toEqual([a, b]);
    expect(await items.getItem(admin, randomUUID())).toBeNull();
    expect(await items.getItem(admin, 'not-a-uuid')).toBeNull();
  });
});
