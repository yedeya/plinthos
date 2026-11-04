import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import * as schema from '../../src/db/schema';
import { ADMIN_GUARD } from '../../src/server/auth/admin';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../src/server/auth/admin-context';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';
import { storedKey } from '../../src/server/photos/keys';
import { freshDatabase, type FreshDatabase } from '../support/fresh-database';
import { memoryBucket } from '../server/photos/fakes';

// The session check is stood in for, the photo bucket is an in-memory one, and the database is a
// fresh one of the test server's: CI has no AWS.
const state = vi.hoisted(() => ({ admin: null as AdminContext | null, db: undefined as unknown, bucket: undefined as ReturnType<typeof memoryBucket> | undefined }));
vi.mock('../../src/server/database', () => ({ database: () => state.db }));
vi.mock('../../src/server/auth/sessions', () => ({
  authenticate: async (cookie: string | undefined) => (cookie === 'made-up-valid-session' ? state.admin : null),
}));
vi.mock('../../src/server/photos/aws', () => ({
  photosBucket: () => 'made-up-photo-bucket',
  s3PhotoStorage: () => {
    if (state.bucket === undefined) throw new Error('the test set no bucket');
    return state.bucket.storage;
  },
}));

const { GET } = await import('../../src/app/admin/api/photos/covers/[itemId]/route');
const { presignCoverThumbnail } = await import('../../src/server/photos/photos');

/**
 * `GET /admin/api/photos/covers/{itemId}` (#255, [EXP-5]): the printable catalogue's thumbnail of an
 * item's cover, a redirect to a presigned GET of its stored thumbnail, the photo the catalogue
 * shows first; 404 for an item without a photo or an id that is not one. The route test
 * (`admin-routes.test.ts`) lists it with every admin route and refuses an anonymous request.
 */

const ORIGIN = 'https://admin.example.test';
const NOW = new Date('2026-11-03T08:00:00.000Z');
const signedIn = { cookie: `${SESSION_COOKIE}=made-up-valid-session`, origin: ORIGIN, host: 'admin.example.test', 'sec-fetch-site': 'same-origin' };

let fresh: FreshDatabase;
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
  state.bucket = memoryBucket();
  state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
});
afterEach(() => {
  state.admin = null;
});

async function anItem(): Promise<string> {
  const id = randomUUID();
  await fresh.db.insert(schema.collectionItem).values({ id, kind: 'OTHER', name: 'Made-up item', condition: 'SEALED', description: '', quantity: 1, storageLocation: 'made-up shelf', version: 1, createdAt: NOW, updatedAt: NOW });
  return id;
}

/** A photo of the item, at a position and added at a minute past `NOW`, with its thumbnail's key. */
async function aPhoto(itemId: string, position: number | null, minute: number): Promise<{ id: string; thumbnailKey: string }> {
  const id = randomUUID();
  const thumbnailKey = storedKey();
  await fresh.db.insert(schema.photo).values({ id, itemId, position, fullKey: storedKey(), thumbnailKey, sha256: 'made-up', createdAt: new Date(NOW.getTime() + minute * 60_000) });
  return { id, thumbnailKey };
}

const get = (itemId: string, headers: Record<string, string> = signedIn) =>
  GET(new Request(`${ORIGIN}/admin/api/photos/covers/${itemId}`, { headers }), { params: Promise.resolve({ itemId }) });

describe('GET /admin/api/photos/covers/{itemId}', () => {
  it('[EXP-5] [AUTH-3] is an admin route, and answers an anonymous request 401 without presigning', async () => {
    expect((GET as unknown as Record<symbol, unknown>)[ADMIN_GUARD]).toBe('route');
    const item = await anItem();
    await aPhoto(item, 0, 0);
    expect((await get(item, {})).status).toBe(401);
    expect(state.bucket?.presignedReads).toEqual([]);
  });

  it('[EXP-5] redirects to the cover’s presigned thumbnail, never cached', async () => {
    const item = await anItem();
    await aPhoto(item, 0, 0);
    const cover = await aPhoto(item, 1, 1);
    await fresh.db.update(schema.collectionItem).set({ coverPhotoId: cover.id });
    const response = await get(item);
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBe(`https://photos.fake-s3.test/${cover.thumbnailKey}?X-Amz-Expires=600`);
  });

  it('[EXP-5] takes the first photo in the admin’s order when the item names no cover, as the catalogue does', async () => {
    const item = await anItem();
    await aPhoto(item, null, 0);
    const first = await aPhoto(item, 2, 2);
    await aPhoto(item, 5, 1);
    expect(await presignCoverThumbnail(state.admin as AdminContext, { itemId: item })).toBe(`https://photos.fake-s3.test/${first.thumbnailKey}?X-Amz-Expires=600`);
  });

  it('[EXP-5] answers 404 for an item without a photo, an unknown item and an id that is not one', async () => {
    const item = await anItem();
    for (const id of [item, randomUUID(), 'not-an-id']) {
      const response = await get(id);
      expect(response.status, id).toBe(404);
      expect(response.headers.get('location'), id).toBeNull();
    }
    expect(state.bucket?.presignedReads).toEqual([]);
  });

  it('[EXP-5] refuses a caller that is not the admin', async () => {
    await expect(presignCoverThumbnail({} as AdminContext, { itemId: randomUUID() })).rejects.toThrow(NotAdminError);
  });
});
