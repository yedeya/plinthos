import { createHash, randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { fitWithin, PRESIGN_ENDPOINT, queuePhoto, sha256Hex } from '../../../src/app/_offline/photos';
import { deleteQueue, openQueue, type OfflineQueue } from '../../../src/app/_offline/queue';
import { replayQueue, retryDelayMs, SYNC_ENDPOINT } from '../../../src/app/_offline/replay';
import { prepareSignOut } from '../../../src/app/_offline/sign-out';
import { QUARANTINE_KEY, quarantineKey } from '../../../src/server/photos/keys';
import { RegisterPhotoInput } from '../../../src/server/photos/photos';
import { MAX_PHOTOS_PER_BATCH, PHOTO_MUTATION } from '../../../src/server/sync/limits';
import { QueuedMutation, SyncBatch, type MutationOutcome } from '../../../src/server/sync/replay';

/**
 * The phone's half of the photo path (#22, #9): a photo is queued with its bytes, uploaded
 * straight to the store through a presigned upload when the queue replays, and its
 * `registerPhoto` sent with the quarantine key; the bytes leave the device only when the server
 * answers it as applied or already applied ([SYNC-8], [PHOTO-2]). The presign route, S3 and the
 * sync endpoint are stand-ins that check what they get against the server's own schemas.
 */

const S3_URL = 'https://photos.fake-s3.test/';

interface Phone {
  readonly fetch: typeof fetch;
  /** Every request, as `<method> <url>`. */
  readonly requests: string[];
  /** What the stand-in S3 holds, by key. */
  readonly s3: Map<string, Uint8Array>;
  readonly registered: { id: string; quarantineKey: string; sha256: string }[];
  /** Every batch the sync endpoint was sent, in order. */
  readonly batches: QueuedMutation[][];
}

type Decide = (mutation: QueuedMutation, s3: Map<string, Uint8Array>) => MutationOutcome;

const applyIfUploaded: Decide = (mutation, s3) => {
  const input = RegisterPhotoInput.parse(mutation.input);
  return s3.has(input.quarantineKey)
    ? { id: mutation.id, outcome: 'applied', result: { photoId: randomUUID() } }
    : { id: mutation.id, outcome: 'invalid', issues: ['gone'], code: 'upload-missing' };
};

function phone(options: { decide?: Decide; presignStatus?: number; s3Status?: number; s3Down?: boolean } = {}): Phone {
  const requests: string[] = [];
  const s3 = new Map<string, Uint8Array>();
  const registered: Phone['registered'] = [];
  const batches: QueuedMutation[][] = [];
  const decide = options.decide ?? applyIfUploaded;
  const fake = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    requests.push(`${init.method ?? 'GET'} ${String(url)}`);
    if (String(url) === PRESIGN_ENDPOINT) {
      if (options.presignStatus !== undefined) return Response.json({ error: 'refused' }, { status: options.presignStatus });
      const key = quarantineKey();
      return Response.json({ key, url: S3_URL, fields: { key, 'Content-Type': 'image/jpeg', Policy: 'made-up' }, maxBytes: 1024 * 1024, expiresAt: new Date().toISOString() });
    }
    if (String(url) === S3_URL) {
      if (options.s3Down === true) throw new TypeError('network down');
      expect(init.credentials).toBe('omit');
      const form = init.body as FormData;
      const names = [...form.keys()];
      expect(names.at(-1)).toBe('file');
      if (options.s3Status !== undefined) return new Response(null, { status: options.s3Status });
      s3.set(String(form.get('key')), new Uint8Array(await (form.get('file') as Blob).arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    if (String(url) === SYNC_ENDPOINT) {
      const mutations = SyncBatch.parse(JSON.parse(String(init.body))).mutations.map((raw) => QueuedMutation.parse(raw));
      batches.push(mutations);
      const outcomes: MutationOutcome[] = [];
      for (const mutation of mutations) {
        if (outcomes.some((outcome) => !['applied', 'already-applied'].includes(outcome.outcome))) {
          outcomes.push({ id: mutation.id, outcome: 'not-attempted' });
          continue;
        }
        if (mutation.name === 'registerPhoto') registered.push({ id: mutation.id, ...RegisterPhotoInput.parse(mutation.input) });
        outcomes.push(mutation.name === 'registerPhoto' ? decide(mutation, s3) : { id: mutation.id, outcome: 'applied', result: null });
      }
      return Response.json({ outcomes });
    }
    throw new Error(`unexpected request to ${String(url)}`);
  };
  return { fetch: fake as typeof fetch, requests, s3, registered, batches };
}

const photoBytes = (seed = 1): ArrayBuffer => new Uint8Array(Array.from({ length: 300 }, (_, index) => (index * seed) % 251)).buffer;

async function queueWithPhoto(bytes = photoBytes()): Promise<{ queue: OfflineQueue; id: string; factory: IDBFactory }> {
  const factory = new IDBFactory();
  const queue = await openQueue(factory);
  const entry = await queuePhoto(queue, bytes);
  return { queue, id: entry.id, factory };
}

describe('a queued photo', () => {
  it('[PHOTO-1] is drawn no larger than the longest edge, never enlarged, with its proportions', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it('[PHOTO-2] is queued as a registerPhoto with the SHA-256 of its bytes, which stay on the device with it', async () => {
    const bytes = photoBytes();
    const { queue } = await queueWithPhoto(bytes);
    const [entry] = await queue.entries();
    const expected = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(entry).toMatchObject({ name: 'registerPhoto', input: { sha256: expected } });
    expect(new Uint8Array(entry?.upload?.bytes ?? new ArrayBuffer(0))).toEqual(new Uint8Array(bytes));
    expect(entry?.upload?.quarantineKey).toBeUndefined();
  });

  it('[PHOTO-1] [PHOTO-2] [SYNC-8] is uploaded straight to the store before its registerPhoto is sent with the quarantine key, and leaves the queue once applied', async () => {
    const { queue, id } = await queueWithPhoto();
    const device = phone();
    const result = await replayQueue(queue, { fetch: device.fetch });
    expect(result).toMatchObject({ status: 'synced', applied: 1, pending: 0 });
    expect(device.requests).toEqual([`POST ${PRESIGN_ENDPOINT}`, `POST ${S3_URL}`, `POST ${SYNC_ENDPOINT}`]);
    const [registered] = device.registered;
    expect(registered?.id).toBe(id);
    expect(registered?.quarantineKey).toMatch(QUARANTINE_KEY);
    expect(device.s3.has(registered?.quarantineKey ?? '')).toBe(true);
    expect(await queue.count()).toBe(0);
  });

  it('[PHOTO-8] [SYNC-8] keeps its bytes and its key when the sync call cannot be made after the upload, and sends the same key next time (#9)', async () => {
    const { queue, id } = await queueWithPhoto();
    const device = phone();
    const offlineAfterUpload: typeof fetch = async (url, init) => {
      if (String(url) === SYNC_ENDPOINT) throw new TypeError('network down');
      return device.fetch(url, init);
    };
    expect((await replayQueue(queue, { fetch: offlineAfterUpload })).status).toBe('offline');
    const [kept] = await queue.entries();
    expect(kept?.id).toBe(id);
    expect(kept?.upload?.bytes.byteLength).toBe(300);
    const key = kept?.upload?.quarantineKey;
    expect(key).toMatch(QUARANTINE_KEY);

    expect((await replayQueue(queue, { fetch: device.fetch })).status).toBe('synced');
    expect(device.registered.map((entry) => entry.quarantineKey)).toEqual([key]);
    expect(device.requests.filter((request) => request.includes(PRESIGN_ENDPOINT))).toHaveLength(1);
  });

  it('[PHOTO-8] [SYNC-8] is uploaded again under the same id when the server says its upload is gone, and then applied (#9)', async () => {
    const { queue, id } = await queueWithPhoto();
    const device = phone();
    await queue.setUploadKey(id, quarantineKey());
    const result = await replayQueue(queue, { fetch: device.fetch });
    expect(result.status).toBe('synced');
    expect(device.registered.map((entry) => entry.id)).toEqual([id, id]);
    expect(device.registered[0]?.sha256).toBe(device.registered[1]?.sha256);
    expect(device.registered[0]?.quarantineKey).not.toBe(device.registered[1]?.quarantineKey);
  });

  it('[PHOTO-8] [SYNC-8] is deferred, not held, with its bytes and key when it fails; its automatic retry re-uploads on upload-missing under the same id, keeping its failure count, and a later applied removes it', async () => {
    const { queue, id } = await queueWithPhoto();
    const START = Date.parse('2026-11-02T09:00:00Z');
    // The server's answers in turn. A failure deletes the quarantined upload, as registerPhoto's
    // `settled` does on every outcome ([PHOTO-3]), so the retry finds it gone.
    const answers: Decide[] = [
      (mutation, s3) => {
        s3.delete(RegisterPhotoInput.parse(mutation.input).quarantineKey);
        return { id: mutation.id, outcome: 'failed', requestId: 'made-up-request-1' };
      },
      applyIfUploaded,
      (mutation, s3) => {
        s3.delete(RegisterPhotoInput.parse(mutation.input).quarantineKey);
        return { id: mutation.id, outcome: 'failed', requestId: 'made-up-request-2' };
      },
      applyIfUploaded,
    ];
    let call = 0;
    const device = phone({ decide: (mutation, s3) => (answers[call++] ?? applyIfUploaded)(mutation, s3) });

    expect((await replayQueue(queue, { fetch: device.fetch, now: () => START })).status).toBe('retrying');
    const [deferred] = await queue.entries();
    expect(deferred?.held).toBeUndefined();
    expect(deferred?.retry?.failures).toBe(1);
    expect(deferred?.upload?.bytes.byteLength).toBe(300);
    const firstKey = deferred?.upload?.quarantineKey;
    expect(firstKey).toMatch(QUARANTINE_KEY);

    // Not before its backoff has passed: nothing is uploaded or sent.
    const before = device.requests.length;
    expect((await replayQueue(queue, { fetch: device.fetch, now: () => START + retryDelayMs(1) - 1 })).status).toBe('retrying');
    expect(device.requests).toHaveLength(before);

    // The retry sends the same key, is told the upload is gone, uploads again under the same id,
    // and fails once more: still deferred, with its failure count carried, not reset.
    const second = START + retryDelayMs(1);
    expect((await replayQueue(queue, { fetch: device.fetch, now: () => second })).status).toBe('retrying');
    expect(device.registered.map((entry) => entry.id)).toEqual([id, id, id]);
    expect(device.registered[1]?.quarantineKey).toBe(firstKey);
    expect(device.registered[2]?.quarantineKey).not.toBe(firstKey);
    expect(new Set(device.registered.map((entry) => entry.sha256)).size).toBe(1);
    const [again] = await queue.entries();
    expect(again?.held).toBeUndefined();
    expect(again?.retry?.failures).toBe(2);
    expect(again?.upload?.bytes.byteLength).toBe(300);

    // The next retry uploads again and is applied: the photo leaves the queue, bytes and all.
    expect(await replayQueue(queue, { fetch: device.fetch, now: () => second + retryDelayMs(2) })).toEqual({ status: 'synced', applied: 1, pending: 0 });
    expect(device.registered.map((entry) => entry.id)).toEqual([id, id, id, id, id]);
    expect(await queue.entries()).toEqual([]);
  });

  it('[PHOTO-8] [SYNC-8] is held, with its bytes, when its upload goes missing twice in one replay, and a retry uploads it again', async () => {
    const { queue, id } = await queueWithPhoto();
    const gone: Decide = (mutation) => ({ id: mutation.id, outcome: 'invalid', issues: ['gone'], code: 'upload-missing' });
    const result = await replayQueue(queue, { fetch: phone({ decide: gone }).fetch });
    expect(result.status).toBe('held');
    const [held] = await queue.entries();
    expect(held?.held).toMatchObject({ outcome: 'invalid', code: 'upload-missing' });
    expect(held?.upload?.bytes.byteLength).toBe(300);
    await queue.release(id);
    expect((await replayQueue(queue, { fetch: phone().fetch })).status).toBe('synced');
  });

  it('[PHOTO-5] [SYNC-8] is held with its bytes when the server refuses it, and nothing queued after it is sent', async () => {
    const queue = await openQueue(new IDBFactory());
    await queuePhoto(queue, photoBytes());
    await queue.enqueue({ name: 'deletePhoto', input: { photoId: randomUUID() } });
    const refused: Decide = (mutation) => ({ id: mutation.id, outcome: 'invalid', issues: ['not a JPEG'], code: 'undecodable' });
    const device = phone({ decide: refused });
    expect((await replayQueue(queue, { fetch: device.fetch })).status).toBe('held');
    const entries = await queue.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.held).toMatchObject({ outcome: 'invalid', code: 'undecodable' });
    expect(entries[0]?.upload?.bytes.byteLength).toBe(300);
  });

  it('[PHOTO-1] is held when the store refuses the upload, as it does one over the size cap, without a sync call', async () => {
    const { queue } = await queueWithPhoto();
    const device = phone({ s3Status: 400 });
    expect((await replayQueue(queue, { fetch: device.fetch })).status).toBe('held');
    expect(device.requests).not.toContain(`POST ${SYNC_ENDPOINT}`);
    const [held] = await queue.entries();
    expect(held?.held?.outcome).toBe('invalid');
  });

  it('[SYNC-8] stays queued as it was when the session has ended or the store can’t be reached', async () => {
    const signedOut = await queueWithPhoto();
    expect((await replayQueue(signedOut.queue, { fetch: phone({ presignStatus: 401 }).fetch })).status).toBe('signed-out');
    const offline = await queueWithPhoto();
    expect((await replayQueue(offline.queue, { fetch: phone({ s3Down: true }).fetch })).status).toBe('offline');
    for (const { queue } of [signedOut, offline]) {
      const [entry] = await queue.entries();
      expect(entry?.held).toBeUndefined();
      expect(entry?.upload?.quarantineKey).toBeUndefined();
      expect(entry?.upload?.bytes.byteLength).toBe(300);
    }
  });

  it('[SYNC-9] is deleted from the device, bytes and all, by a confirmed logout', async () => {
    const { factory } = await queueWithPhoto();
    const warnings: string[] = [];
    const proceed = await prepareSignOut({
      openQueue: () => openQueue(factory),
      deleteQueue: () => deleteQueue(factory),
      deleteSetIndex: async () => undefined,
      caches: undefined,
      online: () => true,
      confirm: (message) => warnings.push(message) > 0,
      alert: () => undefined,
    });
    expect(proceed).toBe(true);
    expect(warnings).toEqual([expect.stringContaining('1 change has not been synced')]);
    const reopened = await openQueue(factory);
    expect(await reopened.entries()).toEqual([]);
  });
});

describe('a long queue of photos', () => {
  it('[SYNC-10] is sent in batches of no more than MAX_PHOTOS_PER_BATCH photos, in queue order, each uploading only its own photos before it is sent (#95)', async () => {
    const queue = await openQueue(new IDBFactory());
    const ids: string[] = [];
    for (let index = 0; index < 2 * MAX_PHOTOS_PER_BATCH + 2; index++) {
      // Other mutations between the photos, one of them right after the cap's last photo.
      if (index === 1 || index === MAX_PHOTOS_PER_BATCH) ids.push((await queue.enqueue({ name: 'test.label', input: { label: `before photo ${index}` } })).id);
      ids.push((await queuePhoto(queue, photoBytes(index + 2))).id);
    }
    const device = phone();
    expect(await replayQueue(queue, { fetch: device.fetch })).toEqual({ status: 'synced', applied: ids.length, pending: 0 });

    // The stand-in endpoint parses each batch with the server's own schema, which refuses one over the cap.
    const photosIn = (batch: readonly QueuedMutation[]) => batch.filter((mutation) => mutation.name === PHOTO_MUTATION).length;
    expect(device.batches.map(photosIn)).toEqual([MAX_PHOTOS_PER_BATCH, MAX_PHOTOS_PER_BATCH, 2]);
    expect(device.batches.flat().map((mutation) => mutation.id)).toEqual(ids);
    // Each batch's photos are uploaded just before it is sent, and no later batch's photo before it.
    const uploadsBeforeEachBatch = device.requests.flatMap((request, index) =>
      request === `POST ${SYNC_ENDPOINT}` ? [device.requests.slice(0, index).filter((earlier) => earlier === `POST ${S3_URL}`).length] : [],
    );
    expect(uploadsBeforeEachBatch).toEqual([MAX_PHOTOS_PER_BATCH, 2 * MAX_PHOTOS_PER_BATCH, 2 * MAX_PHOTOS_PER_BATCH + 2]);
  });
});

describe('the upload progress', () => {
  it('[SYNC-12] is reported before the first upload and after each one, out of the photos this replay uploads (#203)', async () => {
    const queue = await openQueue(new IDBFactory());
    await queue.enqueue({ name: 'test.label', input: { label: 'an item before its photos' } });
    for (let index = 0; index < 3; index++) await queuePhoto(queue, photoBytes(index + 2));
    const progress: { uploaded: number; total: number }[] = [];
    const result = await replayQueue(queue, { fetch: phone().fetch, onProgress: (event) => progress.push(event) });
    expect(result.status).toBe('synced');
    expect(progress).toEqual([
      { uploaded: 0, total: 3 },
      { uploaded: 1, total: 3 },
      { uploaded: 2, total: 3 },
      { uploaded: 3, total: 3 },
    ]);
  });

  it('[SYNC-12] counts every batch’s photos in one total, and reports nothing for a replay with no photo to upload', async () => {
    const queue = await openQueue(new IDBFactory());
    const count = 2 * MAX_PHOTOS_PER_BATCH + 1;
    for (let index = 0; index < count; index++) await queuePhoto(queue, photoBytes(index + 2));
    const progress: { uploaded: number; total: number }[] = [];
    await replayQueue(queue, { fetch: phone().fetch, onProgress: (event) => progress.push(event) });
    expect(new Set(progress.map((event) => event.total))).toEqual(new Set([count]));
    // One report before each batch's uploads begin, with what is already up, then one after each upload.
    const batch = (start: number, size: number) => [start, ...Array.from({ length: size }, (_, index) => start + index + 1)];
    expect(progress.map((event) => event.uploaded)).toEqual([...batch(0, MAX_PHOTOS_PER_BATCH), ...batch(MAX_PHOTOS_PER_BATCH, MAX_PHOTOS_PER_BATCH), ...batch(2 * MAX_PHOTOS_PER_BATCH, 1)]);

    const quiet: unknown[] = [];
    await queue.enqueue({ name: 'test.label', input: { label: 'no photo' } });
    await replayQueue(queue, { fetch: phone().fetch, onProgress: (event) => quiet.push(event) });
    expect(quiet).toEqual([]);
  });

  it('[SYNC-12] adds a photo uploaded again to the total, so it never reads more than all of them', async () => {
    const { queue } = await queueWithPhoto();
    let first = true;
    const device = phone({
      decide: (mutation, s3) => {
        if (!first) return applyIfUploaded(mutation, s3);
        first = false;
        return { id: mutation.id, outcome: 'invalid', issues: ['gone'], code: 'upload-missing' };
      },
    });
    const progress: { uploaded: number; total: number }[] = [];
    expect((await replayQueue(queue, { fetch: device.fetch, onProgress: (event) => progress.push(event) })).status).toBe('synced');
    expect(progress).toEqual([
      { uploaded: 0, total: 1 },
      { uploaded: 1, total: 1 },
      { uploaded: 1, total: 2 },
      { uploaded: 2, total: 2 },
    ]);
  });
});
