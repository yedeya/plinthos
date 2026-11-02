import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { CLASSIFICATION } from '../../../src/db/schema/classification';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { createCatalogueService, LOOKUP_BUDGET_MS } from '../../../src/server/catalogue/sets';
import { createItemService, ITEM_REFUSALS, SaveItemInput } from '../../../src/server/items/items';
import { QUARANTINE_PREFIX } from '../../../src/server/photos/keys';
import { createPhotoService } from '../../../src/server/photos/photos';
import { MUTATIONS } from '../../../src/server/sync/mutations';
import { syncRegistry } from '../../../src/server/sync/registry';
import { createReplay, type MutationOutcome } from '../../../src/server/sync/replay';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { barrier, fakeCatalogue, MADE_UP_SETS, type FakeCatalogue } from '../catalogue/fakes';
import { captureLogger } from '../capture';
import { memoryBucket, plainPhoto, sha256, type MemoryBucket } from '../photos/fakes';

/**
 * The collection item through the offline-sync replay, as the deployed endpoint runs it, over the
 * test database, a stand-in catalogue and an in-memory photo bucket (#133, [ITEM-1] to [ITEM-6]).
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let bucket: MemoryBucket;
let catalogue: FakeCatalogue;
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
  catalogue = fakeCatalogue();
  capture = captureLogger();
});

function services() {
  const sets = createCatalogueService({ provider: () => catalogue.provider });
  const photos = createPhotoService({ storage: () => bucket.storage, settings: () => ({ longestEdge: 1024, maxBytes: 256 * 1024 }), log: capture.log });
  const items = createItemService({ storage: () => bucket.storage, catalogue: () => sets, log: capture.log });
  return { photos, items, run: createReplay(syncRegistry([...photos.mutations, ...items.mutations]), { log: capture.log }) };
}

type Fields = Partial<Record<string, unknown>>;

function itemInput(id: string, fields: Fields = {}) {
  return {
    id,
    setNum: '90001-1',
    condition: 'USED_WITH_BOX',
    complete: true,
    hasInstructions: true,
    description: 'Made-up: light sun fade on the box.',
    quantity: 1,
    storageLocation: 'Made-up shelf B3',
    ...fields,
  };
}

async function one(mutation: { name: string; input: unknown; baseVersion?: number | null }): Promise<MutationOutcome> {
  const { outcomes } = await services().run(admin, { mutations: [{ id: randomUUID(), ...mutation }] });
  const [outcome] = outcomes;
  if (outcome === undefined) throw new Error('no outcome');
  return outcome;
}

const save = (id: string, fields: Fields = {}, baseVersion: number | null = null) => one({ name: 'saveItem', input: itemInput(id, fields), baseVersion });

async function rows(table: string, order = 'id'): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query(`select * from ${table} order by ${order}`)).rows as Record<string, unknown>[];
}

/** Registers one photo through the replay, as the phone's queue does, optionally for an item. */
async function photoFor(itemId?: string, position?: number): Promise<string> {
  const { photos } = services();
  const bytes = await plainPhoto(40 + Math.floor(Math.random() * 20), 30);
  const presigned = await photos.presignPhotoUpload(admin, {});
  bucket.upload(presigned.key, bytes);
  const input = { quarantineKey: presigned.key, sha256: sha256(bytes), ...(itemId === undefined ? {} : { itemId }), ...(position === undefined ? {} : { position }) };
  const outcome = await one({ name: 'registerPhoto', input });
  if (outcome.outcome !== 'applied') throw new Error(`registerPhoto came to ${JSON.stringify(outcome)}`);
  return (outcome.result as { photoId: string }).photoId;
}

async function photosOf(itemId: string): Promise<{ id: string; position: number }[]> {
  return (await fresh.client.query<{ id: string; position: number }>('select id, position from photo where item_id = $1 order by position', [itemId])).rows;
}

async function coverOf(itemId: string): Promise<string | null> {
  return (await fresh.client.query<{ cover_photo_id: string | null }>('select cover_photo_id from collection_item where id = $1', [itemId])).rows[0]?.cover_photo_id ?? null;
}

describe('the item record', () => {
  it('[ITEM-1] stores an item under the client’s UUID with every field, version 1, and when it was created and changed', async () => {
    const id = randomUUID();
    const outcome = await save(id, { complete: false, missingNote: 'Made-up: two minifigures' });
    expect(outcome).toMatchObject({ outcome: 'applied', result: { id, version: 1, setNum: '90001-1' } });
    const [row] = await rows('collection_item');
    expect(row).toMatchObject({
      id,
      set_num: '90001-1',
      condition: 'USED_WITH_BOX',
      complete: false,
      missing_note: 'Made-up: two minifigures',
      has_instructions: true,
      description: 'Made-up: light sun fade on the box.',
      quantity: 1,
      storage_location: 'Made-up shelf B3',
      cover_photo_id: null,
      version: 1,
    });
    expect(row?.created_at).toBeInstanceOf(Date);
    expect(row?.updated_at).toEqual(row?.created_at);
  });

  it('[ITEM-1] refuses a condition, a quantity, a description or a storage location outside its bounds, and an id that is not a UUID', () => {
    const id = randomUUID();
    expect(SaveItemInput.safeParse(itemInput(id)).success).toBe(true);
    for (const condition of ['SEALED', 'USED_WITH_BOX', 'USED_NO_BOX']) expect(SaveItemInput.safeParse(itemInput(id, { condition })).success, condition).toBe(true);
    expect(SaveItemInput.safeParse(itemInput(id, { quantity: 999, description: 'd'.repeat(2000), storageLocation: 's'.repeat(200) })).success).toBe(true);
    for (const fields of [
      { condition: 'MINT' },
      { quantity: 0 },
      { quantity: 1000 },
      { quantity: 1.5 },
      { description: 'd'.repeat(2001) },
      { storageLocation: 's'.repeat(201) },
      { id: 'not-a-uuid' },
      { setNum: '' },
      { complete: 'yes' },
    ]) {
      expect(SaveItemInput.safeParse(itemInput(id, fields)).success, JSON.stringify(fields).slice(0, 80)).toBe(false);
    }
  });

  it('[ITEM-1] classifies every column of collection_item, lego_set and the photo’s link, with storage_location private', () => {
    for (const column of ['id', 'set_num', 'condition', 'complete', 'missing_note', 'has_instructions', 'description', 'quantity', 'storage_location', 'cover_photo_id', 'version', 'created_at', 'updated_at']) {
      expect(CLASSIFICATION.collection_item?.[column], column).toBeDefined();
    }
    expect(CLASSIFICATION.collection_item?.storage_location?.visibility).toBe('private');
    for (const column of ['item_id', 'position']) expect(CLASSIFICATION.photo?.[column]?.visibility, column).toBe('private');
  });

  it('[ITEM-2] saveItem, deleteItem and setItemPhotos are registered sync mutations of the production registry', () => {
    expect([...MUTATIONS.keys()]).toEqual(expect.arrayContaining(['saveItem', 'deleteItem', 'setItemPhotos', 'registerPhoto', 'deletePhoto']));
  });

  it('[ITEM-2] every item function refuses anything but an AdminContext from the session check, before it reads or writes', async () => {
    const { items } = services();
    const forged = { sessionKey: randomUUID(), requestId: randomUUID() } as unknown as AdminContext;
    const id = randomUUID();
    await expect(items.saveItem(forged, itemInput(id) as never, { baseVersion: null })).rejects.toThrow(NotAdminError);
    await expect(items.deleteItem(forged, { itemId: id })).rejects.toThrow(NotAdminError);
    await expect(items.setItemPhotos(forged, { itemId: id, photoIds: [], coverPhotoId: null })).rejects.toThrow(NotAdminError);
    await expect(items.listItems(forged, {})).rejects.toThrow(NotAdminError);
    await expect(items.getItem(forged, id)).rejects.toThrow(NotAdminError);
    expect(catalogue.calls).toEqual([]);
    expect(await rows('collection_item')).toEqual([]);
  });

  it('[ITEM-2] saveItem updates an item it is given the current version of, and moves the version on', async () => {
    const id = randomUUID();
    await save(id);
    const updated = await save(id, { quantity: 3, condition: 'SEALED', storageLocation: 'Made-up attic' }, 1);
    expect(updated).toMatchObject({ outcome: 'applied', result: { id, version: 2, quantity: 3, condition: 'SEALED' } });
    const [row] = await rows('collection_item');
    expect(row).toMatchObject({ version: 2, quantity: 3, condition: 'SEALED', storage_location: 'Made-up attic' });
    expect((row?.updated_at as Date).getTime()).toBeGreaterThanOrEqual((row?.created_at as Date).getTime());
  });
});

describe('versions and conflicts', () => {
  it('[ITEM-3] a stale base version is a conflict, answered with the server’s item, and changes nothing', async () => {
    const id = randomUUID();
    await save(id);
    await save(id, { quantity: 2 }, 1);
    const stale = await save(id, { quantity: 5 }, 1);
    expect(stale).toMatchObject({ outcome: 'conflict', reason: 'version', currentVersion: 2, current: { id, version: 2, quantity: 2, setNum: '90001-1' } });
    expect((await rows('collection_item'))[0]).toMatchObject({ version: 2, quantity: 2 });
  });

  it('[ITEM-3] a second create of an item that exists is a version conflict, never an overwrite', async () => {
    const id = randomUUID();
    await save(id, { quantity: 1 });
    const again = await save(id, { quantity: 7 });
    expect(again).toMatchObject({ outcome: 'conflict', reason: 'version', currentVersion: 1, current: { id, quantity: 1 } });
    expect((await rows('collection_item'))[0]).toMatchObject({ quantity: 1, version: 1 });
  });

  it('[ITEM-3] two creates of the same item racing past the version check: the primary key refuses the second, answered as a version conflict, not failed', async () => {
    const id = randomUUID();
    // Both creates look the set up, so both pass the version check before either inserts.
    const both = barrier(2);
    catalogue.gate = () => both.arrive();
    const { run } = services();
    const [first, second] = await Promise.all([
      run(admin, { mutations: [{ id: randomUUID(), name: 'saveItem', input: itemInput(id, { quantity: 1 }), baseVersion: null }] }),
      run(admin, { mutations: [{ id: randomUUID(), name: 'saveItem', input: itemInput(id, { quantity: 2 }), baseVersion: null }] }),
    ]);
    const outcomes = [first.outcomes[0], second.outcomes[0]];
    expect(catalogue.calls).toEqual(['getSet 90001-1', 'getSet 90001-1']);
    expect(outcomes.map((outcome) => outcome?.outcome).sort()).toEqual(['applied', 'conflict']);
    const conflict = outcomes.find((outcome) => outcome?.outcome === 'conflict');
    const applied = outcomes.find((outcome) => outcome?.outcome === 'applied') as { result: { quantity: number } };
    expect(conflict).toMatchObject({ reason: 'version', currentVersion: 1, current: { id, version: 1, quantity: applied.result.quantity } });
    const items = await rows('collection_item');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ quantity: applied.result.quantity, version: 1 });
    expect(await rows('applied_mutation')).toHaveLength(1);
    expect(capture.events().filter((event) => event.businessEvent === 'sync.mutation.failed')).toEqual([]);
  });
});

describe('the set an item names', () => {
  it('[ITEM-4] looks up a set lego_set does not hold within its own time budget, stores it, and then the item', async () => {
    const id = randomUUID();
    expect((await save(id, { setNum: '90002-1' })).outcome).toBe('applied');
    expect(catalogue.calls).toEqual(['getSet 90002-1']);
    expect(catalogue.budgets[0]).toBe(LOOKUP_BUDGET_MS);
    expect(LOOKUP_BUDGET_MS).toBeLessThanOrEqual(5_000);
    expect((await rows('lego_set')).map((row) => row.set_num)).toEqual(['90002-1']);
    // A second item of the same set reads the stored row.
    expect((await save(randomUUID(), { setNum: '90002-1' })).outcome).toBe('applied');
    expect(catalogue.calls).toEqual(['getSet 90002-1']);
  });

  it('[ITEM-4] stores a typed set number without its variant as the first variant', async () => {
    const id = randomUUID();
    expect(await save(id, { setNum: '90003' })).toMatchObject({ outcome: 'applied', result: { setNum: '90003-1' } });
  });

  it('[ITEM-4] refuses a set number Rebrickable does not know as invalid with the code unknown-set, storing nothing', async () => {
    const outcome = await save(randomUUID(), { setNum: '99999-1' });
    expect(outcome).toMatchObject({ outcome: 'invalid', code: ITEM_REFUSALS.unknownSet });
    expect(ITEM_REFUSALS.unknownSet).toBe('unknown-set');
    expect(await rows('collection_item')).toEqual([]);
    expect(await rows('lego_set')).toEqual([]);
    expect(await rows('applied_mutation')).toEqual([]);
  });

  it('[ITEM-4] answers a Rebrickable failure as failed, so the phone retries it, storing nothing', async () => {
    catalogue.failWith = 'timeout';
    const outcome = await save(randomUUID(), { setNum: '90002-1' });
    expect(outcome.outcome).toBe('failed');
    expect(await rows('collection_item')).toEqual([]);
    expect(await rows('applied_mutation')).toEqual([]);
  });

  it('[ITEM-4] never stores an item without its set’s catalogue row: the database refuses one', async () => {
    await expect(
      fresh.client.query(
        `insert into collection_item (id, set_num, condition, complete, has_instructions, quantity, version, created_at, updated_at) values ($1, '99998-1', 'SEALED', true, true, 1, 1, now(), now())`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('deleting an item', () => {
  it('[ITEM-5] deletes the item and every photo linked to it, and each photo’s stored sizes once that has committed', async () => {
    const id = randomUUID();
    await save(id);
    await photoFor(id);
    await photoFor(id);
    const other = await photoFor();
    const sizes = [...bucket.objects.keys()].filter((key) => !key.startsWith(QUARANTINE_PREFIX));
    expect(sizes).toHaveLength(6);
    const seen: number[] = [];
    bucket.beforeChange = async () => {
      seen.push((await fresh.client.query('select 1 from collection_item')).rowCount ?? 0);
    };
    const outcome = await one({ name: 'deleteItem', input: { itemId: id } });
    expect(outcome).toMatchObject({ outcome: 'applied', result: { itemId: id, deleted: true } });
    expect(seen).toEqual([0, 0, 0, 0]);
    expect(await rows('collection_item')).toEqual([]);
    expect((await rows('photo')).map((row) => row.id)).toEqual([other]);
    expect([...bucket.objects.keys()].filter((key) => !key.startsWith(QUARANTINE_PREFIX))).toHaveLength(2);

    const again = await one({ name: 'deleteItem', input: { itemId: id } });
    expect(again).toMatchObject({ outcome: 'applied', result: { itemId: id, deleted: false } });
  });
});

describe('an item’s photos', () => {
  it('[ITEM-6] registerPhoto links a photo to an item that exists, in order, and the first photo is the cover', async () => {
    const id = randomUUID();
    await save(id);
    const first = await photoFor(id, 0);
    const second = await photoFor(id, 1);
    const third = await photoFor(id);
    expect(await photosOf(id)).toEqual([
      { id: first, position: 0 },
      { id: second, position: 1 },
      { id: third, position: 2 },
    ]);
    expect(await coverOf(id)).toBe(first);
  });

  it('[ITEM-6] registerPhoto stores a photo unlinked when its item does not exist, and one without an item as before', async () => {
    const loose = await photoFor(randomUUID(), 0);
    const plain = await photoFor();
    const linked = await fresh.client.query('select id, item_id, position from photo order by id');
    expect(linked.rows).toEqual(expect.arrayContaining([{ id: loose, item_id: null, position: null }, { id: plain, item_id: null, position: null }]));
  });

  it('[ITEM-6] setItemPhotos sets the order and the cover, and refuses a photo that is not the item’s', async () => {
    const id = randomUUID();
    await save(id);
    const a = await photoFor(id);
    const b = await photoFor(id);
    const c = await photoFor(id);
    const outcome = await one({ name: 'setItemPhotos', input: { itemId: id, photoIds: [c, a, b], coverPhotoId: b } });
    expect(outcome.outcome).toBe('applied');
    expect((await photosOf(id)).map((photo) => photo.id)).toEqual([c, a, b]);
    expect(await coverOf(id)).toBe(b);

    const otherItem = randomUUID();
    await save(otherItem);
    const foreign = await photoFor(otherItem);
    const loose = await photoFor();
    for (const input of [
      { itemId: id, photoIds: [a, b, c, foreign], coverPhotoId: a },
      { itemId: id, photoIds: [a, b, c, loose], coverPhotoId: a },
      { itemId: id, photoIds: [a, b, c], coverPhotoId: foreign },
    ]) {
      expect(await one({ name: 'setItemPhotos', input }), JSON.stringify(input)).toMatchObject({ outcome: 'invalid', code: ITEM_REFUSALS.notItemPhoto });
    }
    expect((await photosOf(id)).map((photo) => photo.id)).toEqual([c, a, b]);
    expect(await coverOf(id)).toBe(b);
    expect((await photosOf(otherItem)).map((photo) => photo.id)).toEqual([foreign]);
  });

  it('[ITEM-6] setItemPhotos refuses an item that does not exist, and a list that names a photo twice', async () => {
    expect(await one({ name: 'setItemPhotos', input: { itemId: randomUUID(), photoIds: [], coverPhotoId: null } })).toMatchObject({
      outcome: 'invalid',
      code: ITEM_REFUSALS.unknownItem,
    });
    const id = randomUUID();
    await save(id);
    const a = await photoFor(id);
    expect((await one({ name: 'setItemPhotos', input: { itemId: id, photoIds: [a, a], coverPhotoId: a } })).outcome).toBe('invalid');
  });

  it('[ITEM-6] deleting the cover makes the next photo the cover, and deleting the last leaves none', async () => {
    const id = randomUUID();
    await save(id);
    const a = await photoFor(id);
    const b = await photoFor(id);
    expect(await coverOf(id)).toBe(a);
    expect((await one({ name: 'deletePhoto', input: { photoId: a } })).outcome).toBe('applied');
    expect(await coverOf(id)).toBe(b);
    expect((await one({ name: 'deletePhoto', input: { photoId: b } })).outcome).toBe('applied');
    expect(await coverOf(id)).toBeNull();
  });
});

describe('reading items', () => {
  it('listItems lists the items newest first with their set’s name and a presigned cover thumbnail, filtered by set number or name', async () => {
    const { items } = services();
    const older = randomUUID();
    const newer = randomUUID();
    await save(older, { setNum: '90001-1' });
    await save(newer, { setNum: '90003-1', quantity: 2, condition: 'SEALED' });
    await photoFor(older);
    const all = await items.listItems(admin, {});
    expect(all.map((item) => item.id)).toEqual([newer, older]);
    expect(all[0]).toMatchObject({ setNum: '90003-1', name: 'Made-up Rover', condition: 'SEALED', quantity: 2, coverThumbnailUrl: null });
    expect(all[1]?.coverThumbnailUrl).toMatch(/X-Amz-Expires=\d+/);
    expect(JSON.stringify(all)).not.toContain('Made-up shelf B3');
    expect((await items.listItems(admin, { filter: 'rover' })).map((item) => item.id)).toEqual([newer]);
    expect((await items.listItems(admin, { filter: '90001' })).map((item) => item.id)).toEqual([older]);
    expect(await items.listItems(admin, { filter: '%' })).toEqual([]);
  });

  it('[ITEM-6] getItem answers one item with every field and its photos in order, cover marked, or null', async () => {
    const { items } = services();
    const id = randomUUID();
    await save(id);
    const a = await photoFor(id);
    const b = await photoFor(id);
    const item = await items.getItem(admin, id);
    expect(item).toMatchObject({ id, setNum: '90001-1', name: MADE_UP_SETS[0]?.name, storageLocation: 'Made-up shelf B3', version: 1 });
    expect(item?.photos.map((photo) => [photo.id, photo.isCover])).toEqual([
      [a, true],
      [b, false],
    ]);
    expect(await items.getItem(admin, randomUUID())).toBeNull();
  });
});
