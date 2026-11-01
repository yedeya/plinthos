import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openQueue, type OfflineQueue } from '../../../src/app/_offline/queue';
import { BATCH_SIZE, replayOnce, replayQueue, SYNC_ENDPOINT } from '../../../src/app/_offline/replay';
import { MAX_BATCH, QueuedMutation, SyncBatch, type MutationOutcome } from '../../../src/server/sync/replay';

/**
 * `[SYNC-7]` and `[SYNC-8]`: the IndexedDB queue on the device, and its replay into the
 * offline-sync endpoint. The endpoint here is a stand-in that checks each batch against the
 * server's own schemas and answers with the server's outcome shapes, stopping at the first
 * mutation it does not apply as the server does ([SYNC-4]).
 */

type Decide = (mutation: QueuedMutation) => MutationOutcome;

interface FakeEndpoint {
  readonly fetch: typeof fetch;
  /** The ids of each batch, in the order sent. */
  readonly batches: string[][];
  readonly requests: { url: string; init: RequestInit }[];
}

function endpoint(decide: Decide = (mutation) => ({ id: mutation.id, outcome: 'applied', result: null }), status = 200): FakeEndpoint {
  const batches: string[][] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const fake = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url: String(url), init });
    if (status !== 200) return Response.json({ error: 'refused' }, { status });
    const batch = SyncBatch.parse(JSON.parse(String(init.body)));
    const mutations = batch.mutations.map((raw) => QueuedMutation.parse(raw));
    batches.push(mutations.map((mutation) => mutation.id));
    const outcomes: MutationOutcome[] = [];
    for (const mutation of mutations) {
      const stopped = outcomes.some((outcome) => !['applied', 'already-applied'].includes(outcome.outcome));
      outcomes.push(stopped ? { id: mutation.id, outcome: 'not-attempted' } : decide(mutation));
    }
    return Response.json({ outcomes }, { headers: { 'cache-control': 'no-store' } });
  };
  return { fetch: fake as typeof fetch, batches, requests };
}

function at(ids: string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw new Error(`no id at ${index}`);
  return id;
}

async function queueWith(names: string[], factory = new IDBFactory()): Promise<{ queue: OfflineQueue; ids: string[]; factory: IDBFactory }> {
  const queue = await openQueue(factory);
  const ids: string[] = [];
  for (const name of names) ids.push((await queue.enqueue({ name, input: { label: name } })).id);
  return { queue, ids, factory };
}

describe('the queue on the device', () => {
  it('[SYNC-7] keeps each change in the order it was made, with a fresh UUID the endpoint accepts', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second', 'test.third']);
    const entries = await queue.entries();
    expect(entries.map((entry) => entry.name)).toEqual(['test.first', 'test.second', 'test.third']);
    expect(entries.map((entry) => entry.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    for (const entry of entries) expect(QueuedMutation.safeParse({ id: entry.id, name: entry.name, input: entry.input }).success).toBe(true);
    const versioned = await queue.enqueue({ name: 'test.versioned', input: {}, baseVersion: 3 });
    expect(versioned.baseVersion).toBe(3);
  });

  it('[SYNC-7] survives a reload and a restart of the browser: a new connection finds it as it was left', async () => {
    const { queue, ids, factory } = await queueWith(['test.first', 'test.second']);
    await queue.hold(at(ids, 1), { outcome: 'failed', requestId: 'made-up-request-id' });
    queue.close();
    const reopened = await openQueue(factory);
    const entries = await reopened.entries();
    expect(entries.map((entry) => entry.id)).toEqual(ids);
    expect(entries[1]?.held).toMatchObject({ outcome: 'failed', requestId: 'made-up-request-id' });
  });
});

describe('replaying the queue', () => {
  it('[SYNC-7] [SYNC-8] posts the queue in order to the sync endpoint, same-origin and uncached, and empties it once each is applied', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second', 'test.third']);
    const server = endpoint((mutation) => ({ id: mutation.id, outcome: mutation.name === 'test.second' ? 'already-applied' : 'applied', result: { ok: true } }));
    expect(await replayQueue(queue, { fetch: server.fetch })).toEqual({ status: 'synced', applied: 3, pending: 0 });
    expect(server.batches).toEqual([ids]);
    expect(server.requests[0]?.url).toBe(SYNC_ENDPOINT);
    expect(server.requests[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(await queue.count()).toBe(0);
  });

  it('[SYNC-8] keeps the stopped mutation, held with what the server said, and every one after it queued in order', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second', 'test.third', 'test.fourth']);
    const server = endpoint((mutation) =>
      mutation.name === 'test.second'
        ? { id: mutation.id, outcome: 'conflict', reason: 'version', currentVersion: 4, current: { storageLocation: 'made-up private shelf' } }
        : { id: mutation.id, outcome: 'applied', result: null },
    );
    expect(await replayQueue(queue, { fetch: server.fetch })).toEqual({ status: 'held', applied: 1, pending: 3 });
    const entries = await queue.entries();
    expect(entries.map((entry) => entry.id)).toEqual(ids.slice(1));
    expect(entries[0]?.held).toMatchObject({ outcome: 'conflict', reason: 'version' });
    expect(entries.slice(1).every((entry) => entry.held === undefined)).toBe(true);
    // What the server returned of its own record is not kept on the device.
    expect(JSON.stringify(entries)).not.toContain('made-up private shelf');
  });

  it('[SYNC-8] holds an invalid and a failed mutation the same way, and sends nothing past a held one until it is retried or discarded', async () => {
    for (const [outcome, held] of [
      ['invalid', { outcome: 'invalid', issues: ['input.label: made-up issue'] }],
      ['failed', { outcome: 'failed', requestId: 'made-up-request-id' }],
    ] as const) {
      const { queue, ids } = await queueWith(['test.first', 'test.second']);
      const answer = (mutation: QueuedMutation): MutationOutcome =>
        outcome === 'invalid' ? { id: mutation.id, outcome, issues: held.outcome === 'invalid' ? held.issues : [] } : { id: mutation.id, outcome, requestId: 'made-up-request-id' };
      const server = endpoint(answer);
      expect((await replayQueue(queue, { fetch: server.fetch })).status).toBe('held');
      expect((await queue.entries())[0]?.held).toMatchObject(held);
      expect(await replayQueue(queue, { fetch: server.fetch })).toEqual({ status: 'held', applied: 0, pending: 2 });
      expect(server.batches).toEqual([ids]);
    }
  });

  it('[SYNC-8] sends a retried mutation again first, and after a discard sends what came after it', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second', 'test.third']);
    let refuse = true;
    const server = endpoint((mutation) =>
      refuse && mutation.name === 'test.first' ? { id: mutation.id, outcome: 'failed', requestId: 'made-up' } : { id: mutation.id, outcome: 'applied', result: null },
    );
    await replayQueue(queue, { fetch: server.fetch });
    refuse = false;
    await queue.release(at(ids, 0));
    expect(await replayQueue(queue, { fetch: server.fetch })).toEqual({ status: 'synced', applied: 3, pending: 0 });
    expect(server.batches).toEqual([ids, ids]);

    const second = await queueWith(['test.first', 'test.second']);
    refuse = true;
    const other = endpoint((mutation) => (mutation.name === 'test.first' ? { id: mutation.id, outcome: 'conflict', reason: 'payload', result: null } : { id: mutation.id, outcome: 'applied', result: null }));
    await replayQueue(second.queue, { fetch: other.fetch });
    await second.queue.remove(at(second.ids, 0));
    expect(await replayQueue(second.queue, { fetch: other.fetch })).toEqual({ status: 'synced', applied: 1, pending: 0 });
    expect(other.batches).toEqual([second.ids, [second.ids[1]]]);
  });

  it('[SYNC-8] stops on an ended session with the queue untouched, and resumes from the same place after sign-in', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second']);
    expect(await replayQueue(queue, { fetch: endpoint(undefined, 401).fetch })).toEqual({ status: 'signed-out', applied: 0, pending: 2 });
    expect((await queue.entries()).map((entry) => entry.id)).toEqual(ids);
    expect((await queue.entries()).every((entry) => entry.held === undefined)).toBe(true);
    const server = endpoint();
    expect((await replayQueue(queue, { fetch: server.fetch })).status).toBe('synced');
    expect(server.batches).toEqual([ids]);
  });

  it('[SYNC-7] [SYNC-8] keeps everything when the network fails, times out or the server answers otherwise', async () => {
    const { queue, ids } = await queueWith(['test.first']);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect((await replayQueue(queue, { fetch: offline })).status).toBe('offline');
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    expect((await replayQueue(queue, { fetch: hanging, timeoutMs: 5 })).status).toBe('offline');
    for (const status of [403, 500, 503]) expect((await replayQueue(queue, { fetch: endpoint(undefined, status).fetch })).status).toBe('error');
    const short = (async () => Response.json({ outcomes: [] })) as typeof fetch;
    expect((await replayQueue(queue, { fetch: short })).status).toBe('error');
    expect((await queue.entries()).map((entry) => entry.id)).toEqual(ids);
  });

  it('[SYNC-7] sends a long queue in batches no larger than the endpoint takes', async () => {
    expect(BATCH_SIZE).toBe(MAX_BATCH);
    const { queue } = await queueWith(Array.from({ length: 5 }, (_, index) => `test.n${index}`));
    const server = endpoint();
    expect(await replayQueue(queue, { fetch: server.fetch, batchSize: 2 })).toEqual({ status: 'synced', applied: 5, pending: 0 });
    expect(server.batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('[SYNC-7] runs one replay at a time: a second trigger shares the first one\'s result', async () => {
    const { queue } = await queueWith(['test.first']);
    const server = endpoint();
    const [one, two] = await Promise.all([replayOnce(queue, { fetch: server.fetch }), replayOnce(queue, { fetch: server.fetch })]);
    expect(one).toBe(two);
    expect(server.batches).toHaveLength(1);
  });
});
