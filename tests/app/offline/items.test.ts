import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  draftProblems,
  ITEM_MUTATION,
  itemMutations,
  normalizeSetNumber,
  photoMoves,
  queuedItems,
  queueItem,
  queueItemDeletion,
  saveItemInput,
  searchSets,
  SEARCH_MAX_RESULTS,
  SET_SEARCH_ENDPOINT,
  type ItemDraft,
} from '../../../src/app/_offline/items';
import { PRESIGN_ENDPOINT, sha256Hex } from '../../../src/app/_offline/photos';
import { openQueue } from '../../../src/app/_offline/queue';
import { replayQueue, SYNC_ENDPOINT } from '../../../src/app/_offline/replay';
import { quarantineKey } from '../../../src/server/photos/keys';
import { QueuedMutation, SyncBatch } from '../../../src/server/sync/replay';

/**
 * `[ITEM-7]`: a saved item becomes its mutations in the device's queue in order, its `saveItem`
 * before its photos' `registerPhoto`, which carry the item's id, so an item and its photos entered
 * offline sync in that order and arrive linked. Also the list's reading of the queue ([ITEM-8])
 * and the set search's fallback ([CAT-5]). Every value is made up.
 */

const S3_URL = 'https://photos.fake-s3.test/';

function bytes(seed: number): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, seed, seed + 1, 0xff, 0xd9]).buffer;
}

function newDraft(overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    id: randomUUID(),
    baseVersion: null,
    kind: 'SET',
    setNum: '10294-1',
    name: '',
    refNo: '',
    approxParts: null,
    approxWeightG: null,
    condition: 'SEALED',
    complete: true,
    missingNotes: '',
    hasInstructions: true,
    description: 'Made-up description',
    quantity: 1,
    storageLocation: 'Made-up shelf 3',
    photos: [],
    ...overrides,
  };
}

function photo(seed: number) {
  return { kind: 'new' as const, key: randomUUID(), bytes: bytes(seed) };
}

/** A phone with a stand-in presign route, S3 and sync endpoint that applies everything. */
function phone() {
  const batches: QueuedMutation[][] = [];
  const order: string[] = [];
  const fake = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = String(url);
    if (target === PRESIGN_ENDPOINT) {
      order.push('presign');
      const key = quarantineKey();
      return Response.json({ key, url: S3_URL, fields: { key }, maxBytes: 1024 * 1024 });
    }
    if (target === S3_URL) {
      order.push('upload');
      return new Response(null, { status: 204 });
    }
    expect(target).toBe(SYNC_ENDPOINT);
    order.push('sync');
    const batch = SyncBatch.parse(JSON.parse(String(init.body)));
    const mutations = batch.mutations.map((raw) => QueuedMutation.parse(raw));
    batches.push(mutations);
    return Response.json({ outcomes: mutations.map((mutation) => ({ id: mutation.id, outcome: 'applied', result: null })) });
  };
  return { fetch: fake as typeof fetch, batches, order };
}

describe('a saved item in the queue', () => {
  it('[ITEM-7] queues saveItem first, then each photo’s registerPhoto with the item’s id and position, the first photo its cover, and no setItemPhotos', async () => {
    const photos = [photo(1), photo(2), photo(3)];
    const draft = newDraft({ photos });
    const queue = await openQueue(new IDBFactory());
    await queueItem(queue, draft);
    const entries = await queue.entries();
    expect(entries.map((entry) => entry.name)).toEqual([ITEM_MUTATION.save, 'registerPhoto', 'registerPhoto', 'registerPhoto']);
    expect(entries[0]?.baseVersion).toBeUndefined();
    expect(entries[0]).toMatchObject({ input: { id: draft.id, baseVersion: null, setNum: '10294-1', condition: 'SEALED', quantity: 1, storageLocation: 'Made-up shelf 3' } });
    for (const [index, entry] of entries.slice(1).entries()) {
      const shot = photos[index];
      if (shot === undefined) throw new Error('no photo');
      expect(entry.input).toEqual({ sha256: await sha256Hex(shot.bytes), itemId: draft.id, position: index });
      expect(entry.upload?.bytes.byteLength).toBe(shot.bytes.byteLength);
    }
    queue.close();
  });

  it('[ITEM-7] replays an item and its photos in queue order: the photos are uploaded first, then one batch with saveItem ahead of its photos', async () => {
    const photos = [photo(1), photo(2)];
    const draft = newDraft({ photos });
    const queue = await openQueue(new IDBFactory());
    await queueItem(queue, draft);
    const device = phone();
    const result = await replayQueue(queue, { fetch: device.fetch });
    expect(result).toMatchObject({ status: 'synced', applied: 3, pending: 0 });
    expect(device.order).toEqual(['presign', 'upload', 'presign', 'upload', 'sync']);
    const [batch] = device.batches;
    expect(batch?.map((mutation) => mutation.name)).toEqual([ITEM_MUTATION.save, 'registerPhoto', 'registerPhoto']);
    expect(batch?.[0]?.input).toMatchObject({ id: draft.id, baseVersion: null });
    for (const [index, mutation] of (batch ?? []).slice(1).entries()) {
      expect(mutation.input).toMatchObject({ itemId: draft.id, position: index, quarantineKey: expect.stringMatching(/^quarantine\//) });
    }
    queue.close();
  });

  it('[ITEM-7] [ITEM-6] an edit carries its version, deletes the photos removed, reorders the stored ones and adds the new ones after them', async () => {
    const [first, second, removed] = [randomUUID(), randomUUID(), randomUUID()];
    const added = photo(7);
    const stored = (id: string) => ({ kind: 'stored' as const, key: id, id });
    const draft = newDraft({ baseVersion: 4, photos: [stored(second), stored(first), added] });
    const mutations = await itemMutations(draft, { photoIds: [first, removed, second], coverId: first });
    expect(mutations.map((mutation) => mutation.name)).toEqual([ITEM_MUTATION.save, ITEM_MUTATION.deletePhoto, ITEM_MUTATION.setPhotos, 'registerPhoto']);
    expect(mutations[0]).toMatchObject({ input: { id: draft.id, baseVersion: 4 } });
    expect(mutations[1]?.input).toEqual({ photoId: removed });
    expect(mutations[2]?.input).toEqual({ itemId: draft.id, photoIds: [second, first], coverPhotoId: second });
    // Placed after the item's last photo by the server, never at a place it might share.
    expect(mutations[3]?.input).toEqual({ sha256: await sha256Hex(added.bytes), itemId: draft.id });

    // Removing photos, or adding some, while the stored order and the cover stay, sends no order.
    const unchanged = await itemMutations(newDraft({ baseVersion: 2, photos: [stored(first), added] }), { photoIds: [first, removed], coverId: first });
    expect(unchanged.map((mutation) => mutation.name)).toEqual([ITEM_MUTATION.save, ITEM_MUTATION.deletePhoto, 'registerPhoto']);
    // A removed cover passes to the next photo on the server, so that sends no order either ([ITEM-6]).
    const coverRemoved = await itemMutations(newDraft({ baseVersion: 2, photos: [stored(second)] }), { photoIds: [first, second], coverId: first });
    expect(coverRemoved.map((mutation) => mutation.name)).toEqual([ITEM_MUTATION.save, ITEM_MUTATION.deletePhoto]);
  });

  it('[ITEM-6] [ITEM-9] keeps an edit’s new photos after its stored ones, and only a stored photo becomes an edit’s cover', () => {
    const edit = [{ kind: 'stored' as const }, { kind: 'stored' as const }, { kind: 'new' as const }, { kind: 'new' as const }];
    expect(photoMoves(edit, 1)).toEqual({ left: true, right: false, cover: true });
    expect(photoMoves(edit, 2)).toEqual({ left: false, right: true, cover: false });
    const fresh = [{ kind: 'new' as const }, { kind: 'new' as const }];
    expect(photoMoves(fresh, 1)).toEqual({ left: true, right: false, cover: true });
    expect(photoMoves(fresh, 0)).toEqual({ left: false, right: true, cover: false });
  });

  it('[ITEM-7] queues an item and its photos all at once or not at all', async () => {
    const queue = await openQueue(new IDBFactory());
    await expect(queue.enqueueAll([{ name: ITEM_MUTATION.save, input: {} }, { name: 'registerPhoto', input: { notStorable: () => undefined } }])).rejects.toThrow();
    expect(await queue.count()).toBe(0);
    queue.close();
  });

  it('[ITEM-1] keeps the note of what is missing only for an incomplete set, and refuses what the record refuses', () => {
    expect(draftProblems(newDraft())).toEqual({});
    expect(draftProblems(newDraft({ setNum: '', condition: null, quantity: 0, description: 'x'.repeat(2001), storageLocation: 'x'.repeat(201) }))).toEqual({
      setNum: 'required',
      condition: 'required',
      quantity: 'quantity',
      description: 'tooLong',
      storageLocation: 'tooLong',
    });
    expect(draftProblems(newDraft({ quantity: 1000 }))).toEqual({ quantity: 'quantity' });
    expect(draftProblems(newDraft({ setNum: '-10294' }))).toEqual({ setNum: 'setNumber' });
    expect(draftProblems(newDraft({ setNum: 'x'.repeat(41) }))).toEqual({ setNum: 'setNumber' });
    expect(normalizeSetNumber(' 10294 ')).toBe('10294-1');
    expect(normalizeSetNumber('10294-2')).toBe('10294-2');
    expect(normalizeSetNumber('sw0001a')).toBe('sw0001a-1');
    expect(saveItemInput(newDraft({ complete: true, missingNotes: 'Made-up' }))).not.toHaveProperty('missingNotes');
    expect(saveItemInput(newDraft({ complete: false, missingNotes: '  ' }))).toMatchObject({ missingNotes: null });
  });

  it('[ITEM-5] queues a deletion by the item’s id alone, as deleteItem is not versioned', async () => {
    const queue = await openQueue(new IDBFactory());
    const id = randomUUID();
    await queueItemDeletion(queue, id);
    const [entry] = await queue.entries();
    expect(entry).toMatchObject({ name: ITEM_MUTATION.delete, input: { id } });
    expect(entry?.baseVersion).toBeUndefined();
    expect(entry?.input).toEqual({ id });
    queue.close();
  });
});

describe('the items the queue still holds', () => {
  it('[ITEM-8] lists the queued items newest first, with their photos counted and a held one marked', async () => {
    const queue = await openQueue(new IDBFactory());
    const first = newDraft({ setNum: '21318-1', condition: 'USED_NO_BOX', quantity: 2, photos: [photo(1)] });
    const second = newDraft({ setNum: '75192-1', condition: 'USED_WITH_BOX' });
    await queueItem(queue, first);
    await queueItem(queue, second);
    const [held] = await queue.entries();
    if (held === undefined) throw new Error('nothing queued');
    await queue.hold(held.id, { outcome: 'invalid', issues: ['setNum: made-up'], code: 'unknown-set' });
    expect(queuedItems(await queue.entries())).toEqual([
      { id: second.id, kind: 'SET', setNum: '75192-1', name: null, condition: 'USED_WITH_BOX', quantity: 1, created: true, deleted: false, held: false, photos: 0 },
      { id: first.id, kind: 'SET', setNum: '21318-1', name: null, condition: 'USED_NO_BOX', quantity: 2, created: true, deleted: false, held: true, photos: 1 },
    ]);
    queue.close();
  });
});

describe('the set search', () => {
  const set = { setNum: '10294-1', name: 'Made-up Titanic', theme: 'Made-up Icons', year: 2021, numParts: 9090, imageUrl: 'https://cdn.rebrickable.com/media/sets/made-up.jpg' };

  it('[CAT-5] [ITEM-9] asks the admin route, credentials included and never cached, and keeps at most ten results', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ status: 'ok', sets: Array.from({ length: 12 }, (_, index) => ({ ...set, setNum: `${10000 + index}-1` })) });
    }) as unknown as typeof fetch;
    const answer = await searchSets(' 10294 tit ', { fetch: fake });
    expect(seen[0]?.url).toBe(`${SET_SEARCH_ENDPOINT}?q=10294+tit`);
    expect(seen[0]?.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    expect(answer.status === 'ok' ? answer.sets.length : -1).toBe(SEARCH_MAX_RESULTS);
  });

  it('[CAT-5] answers unavailable, never an error, when the route says so, refuses, is missing or cannot be reached', async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => Response.json({ status: 'unavailable' }),
      async () => Response.json({ error: 'Sign in first.' }, { status: 401 }),
      async () => new Response('not found', { status: 404 }),
      async () => new Response('<html>', { status: 200 }),
      async () => {
        throw new TypeError('made-up network failure');
      },
    ];
    for (const answer of answers) expect(await searchSets('titanic', { fetch: answer as unknown as typeof fetch })).toEqual({ status: 'unavailable' });
  });
});
