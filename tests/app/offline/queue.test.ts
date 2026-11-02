import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openQueue, type OfflineQueue } from '../../../src/app/_offline/queue';
import { BATCH_SIZE, MAX_FAILED_ATTEMPTS, replayOnce, replayQueue, retryDelayMs, retryDue, RETRY_BASE_DELAY_MS, SYNC_ENDPOINT } from '../../../src/app/_offline/replay';
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

  it('[SYNC-8] holds an invalid mutation at once, and sends nothing past a held one until it is retried or discarded', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second']);
    const server = endpoint((mutation) => ({ id: mutation.id, outcome: 'invalid', issues: ['input.label: made-up issue'] }));
    expect((await replayQueue(queue, { fetch: server.fetch })).status).toBe('held');
    expect((await queue.entries())[0]?.held).toMatchObject({ outcome: 'invalid', issues: ['input.label: made-up issue'] });
    expect(await replayQueue(queue, { fetch: server.fetch })).toEqual({ status: 'held', applied: 0, pending: 2 });
    expect(server.batches).toEqual([ids]);
  });

  it('[SYNC-8] sends a retried mutation again first, and after a discard sends what came after it', async () => {
    const { queue, ids } = await queueWith(['test.first', 'test.second', 'test.third']);
    let refuse = true;
    const server = endpoint((mutation) =>
      refuse && mutation.name === 'test.first' ? { id: mutation.id, outcome: 'invalid', issues: [] } : { id: mutation.id, outcome: 'applied', result: null },
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

  it('[SYNC-11] sends the rest at once when the server ran out of time for a batch, and never sends again a batch it ran none of', async () => {
    const batches: string[][] = [];
    /** A stand-in endpoint that has time for `room` mutations a batch, and answers the rest not attempted. */
    const outOfTime = (room: number) =>
      (async (_url: string, init: RequestInit) => {
        const mutations = SyncBatch.parse(JSON.parse(String(init.body))).mutations.map((raw) => QueuedMutation.parse(raw));
        batches.push(mutations.map((mutation) => mutation.id));
        const outcomes: MutationOutcome[] = mutations.map((mutation, index) =>
          index < room ? { id: mutation.id, outcome: 'applied', result: null } : { id: mutation.id, outcome: 'not-attempted' },
        );
        return Response.json({ outcomes }, { headers: { 'cache-control': 'no-store' } });
      }) as unknown as typeof fetch;

    const { queue, ids } = await queueWith(Array.from({ length: 5 }, (_, index) => `test.n${index}`));
    expect(await replayQueue(queue, { fetch: outOfTime(2) })).toEqual({ status: 'synced', applied: 5, pending: 0 });
    expect(batches).toEqual([ids, ids.slice(2), ids.slice(4)]);

    batches.length = 0;
    const stuck = await queueWith(['test.first', 'test.second']);
    expect((await replayQueue(stuck.queue, { fetch: outOfTime(0) })).status).toBe('error');
    expect(batches).toEqual([stuck.ids]);
    expect((await stuck.queue.entries()).map((entry) => [entry.id, entry.held])).toEqual(stuck.ids.map((id) => [id, undefined]));
  });

  it('[SYNC-7] runs one replay at a time: a second trigger shares the first one\'s result', async () => {
    const { queue } = await queueWith(['test.first']);
    const server = endpoint();
    const [one, two] = await Promise.all([replayOnce(queue, { fetch: server.fetch }), replayOnce(queue, { fetch: server.fetch })]);
    expect(one).toBe(two);
    expect(server.batches).toHaveLength(1);
  });
});

describe('retrying a mutation that failed on the server', () => {
  const START = Date.parse('2026-11-01T12:00:00Z');

  /** A server that fails `test.flaky` the first `failures` times it is sent, and applies everything else. */
  function flaky(failures: number) {
    let left = failures;
    return endpoint((mutation) => {
      if (mutation.name === 'test.flaky' && left > 0) {
        left--;
        return { id: mutation.id, outcome: 'failed', requestId: `made-up-request-${left}` };
      }
      return { id: mutation.id, outcome: 'applied', result: null };
    });
  }

  it('[SYNC-8] keeps a failed mutation in its place, not held, and sends it again at the next trigger once its backoff has passed', async () => {
    const { queue, ids } = await queueWith(['test.flaky', 'test.after']);
    const server = flaky(1);
    expect(await replayQueue(queue, { fetch: server.fetch, now: () => START })).toEqual({ status: 'retrying', applied: 0, pending: 2 });
    const [first] = await queue.entries();
    expect(first?.held).toBeUndefined();
    expect(first?.retry).toMatchObject({ failures: 1, failedAt: new Date(START).toISOString(), delayMs: retryDelayMs(1) });
    expect(await replayQueue(queue, { fetch: server.fetch, now: () => START + retryDelayMs(1) })).toEqual({ status: 'synced', applied: 2, pending: 0 });
    expect(server.batches).toEqual([ids, ids]);
  });

  it('[SYNC-8] respects the backoff: a trigger before it has passed sends nothing, and each wait is longer than the last', async () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));
    const { queue, ids } = await queueWith(['test.flaky']);
    const server = flaky(2);
    await replayQueue(queue, { fetch: server.fetch, now: () => START });
    expect(await replayQueue(queue, { fetch: server.fetch, now: () => START + retryDelayMs(1) - 1 })).toEqual({ status: 'retrying', applied: 0, pending: 1 });
    expect(server.batches).toEqual([ids]);
    const second = START + retryDelayMs(1);
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => second })).status).toBe('retrying');
    expect((await queue.entries())[0]?.retry).toMatchObject({ failures: 2, failedAt: new Date(second).toISOString(), delayMs: retryDelayMs(2) });
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => second + retryDelayMs(2) - 1 })).status).toBe('retrying');
    expect(server.batches).toHaveLength(2);
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => second + retryDelayMs(2) })).status).toBe('synced');
  });

  it(`[SYNC-8] holds it for the admin after ${MAX_FAILED_ATTEMPTS} failures, and a Retry starts its attempts again`, async () => {
    const { queue, ids } = await queueWith(['test.flaky']);
    const server = flaky(MAX_FAILED_ATTEMPTS + 1);
    let clock = START;
    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt++) {
      expect((await replayQueue(queue, { fetch: server.fetch, now: () => clock })).status).toBe('retrying');
      clock += retryDelayMs(attempt);
    }
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => clock })).status).toBe('held');
    const [held] = await queue.entries();
    expect(held?.held).toMatchObject({ outcome: 'failed' });
    expect(held?.retry).toBeUndefined();
    expect(server.batches).toHaveLength(MAX_FAILED_ATTEMPTS);
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => clock + 10 * retryDelayMs(MAX_FAILED_ATTEMPTS) })).status).toBe('held');
    expect(server.batches).toHaveLength(MAX_FAILED_ATTEMPTS);

    await queue.release(at(ids, 0));
    expect((await queue.entries())[0]?.retry).toBeUndefined();
    // One failure is left in the made-up server: a released mutation gets its attempts back.
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => clock })).status).toBe('retrying');
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => clock + retryDelayMs(1) })).status).toBe('synced');
  });

  it('[SYNC-4] [SYNC-8] keeps the order: everything queued after a failed mutation waits behind it, and is sent after it', async () => {
    const { queue, ids } = await queueWith(['test.before', 'test.flaky', 'test.after', 'test.last']);
    const server = flaky(1);
    expect(await replayQueue(queue, { fetch: server.fetch, now: () => START })).toEqual({ status: 'retrying', applied: 1, pending: 3 });
    expect((await queue.entries()).map((entry) => entry.id)).toEqual(ids.slice(1));
    expect((await queue.entries()).slice(1).every((entry) => entry.retry === undefined && entry.held === undefined)).toBe(true);
    await replayQueue(queue, { fetch: server.fetch, now: () => START });
    expect(server.batches).toEqual([ids]);
    expect(await replayQueue(queue, { fetch: server.fetch, now: () => START + retryDelayMs(1) })).toEqual({ status: 'synced', applied: 3, pending: 0 });
    expect(server.batches).toEqual([ids, ids.slice(1)]);
  });

  it('[SYNC-8] is due at once when the clock moves back to before a failure (#89)', async () => {
    const { queue, ids } = await queueWith(['test.flaky', 'test.after']);
    const server = flaky(1);
    // The clock was an hour ahead when the server answered `failed`, then it was corrected.
    const ahead = START + 60 * 60_000;
    expect((await replayQueue(queue, { fetch: server.fetch, now: () => ahead })).status).toBe('retrying');
    expect(await replayQueue(queue, { fetch: server.fetch, now: () => START })).toEqual({ status: 'synced', applied: 2, pending: 0 });
    expect(server.batches).toEqual([ids, ids]);
  });

  it('[SYNC-8] bounds the wait by the backoff of the failure count, whatever delay or date is stored', () => {
    const failedAt = new Date(START).toISOString();
    expect(retryDue({ failures: 1, failedAt, delayMs: retryDelayMs(1) }, START + retryDelayMs(1) - 1)).toBe(false);
    expect(retryDue({ failures: 1, failedAt, delayMs: retryDelayMs(1) }, START + retryDelayMs(1))).toBe(true);
    expect(retryDue({ failures: 1, failedAt, delayMs: 365 * 24 * 60 * 60_000 }, START + retryDelayMs(1))).toBe(true);
    expect(retryDue({ failures: 1, failedAt, delayMs: retryDelayMs(1) }, START - 1)).toBe(true);
    expect(retryDue({ failures: 1, failedAt: 'not a date', delayMs: retryDelayMs(1) }, START)).toBe(true);
  });
});

describe('the groups of the queue', () => {
  it('[SYNC-8] [ITEM-7] records one group for the mutations one enqueueAll queued, and a group of one for each mutation queued alone', async () => {
    const queue = await openQueue(new IDBFactory());
    const together = await queue.enqueueAll([{ name: 'test.first', input: {} }, { name: 'test.second', input: {} }]);
    const alone = await queue.enqueue({ name: 'test.third', input: {} });
    const [first, second] = together;
    expect(first?.group).toEqual(second?.group);
    expect(alone.group).not.toEqual(first?.group);
    expect((await queue.entries()).map((entry) => entry.group)).toEqual([first?.group, first?.group, alone.group]);
    queue.close();
  });

  it('[SYNC-8] [ITEM-7] discards a held mutation with every mutation still queued in its group, and keeps the next group', async () => {
    const queue = await openQueue(new IDBFactory());
    const [held] = await queue.enqueueAll([{ name: 'test.save', input: {} }, { name: 'test.photo', input: {} }, { name: 'test.photo', input: {} }]);
    const later = await queue.enqueueAll([{ name: 'test.save', input: {} }]);
    if (held === undefined) throw new Error('nothing queued');
    await queue.hold(held.id, { outcome: 'conflict', reason: 'version' });
    const discarded = await queue.discardGroup(held.id);
    expect(discarded.map((entry) => entry.name)).toEqual(['test.save', 'test.photo', 'test.photo']);
    expect((await queue.entries()).map((entry) => entry.id)).toEqual(later.map((entry) => entry.id));
    expect(await queue.discardGroup('made-up-gone')).toEqual([]);
    queue.close();
  });

  it('[SYNC-7] keeps a queue made before groups across the upgrade, each of its entries a group of one', async () => {
    const factory = new IDBFactory();
    const opening = factory.open('plinthos-offline', 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore('mutations', { keyPath: 'seq', autoIncrement: true });
      store.createIndex('id', 'id', { unique: true });
      for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) {
        store.add({ id, name: 'test.old', input: {}, queuedAt: '2026-11-01T12:00:00.000Z' });
      }
    };
    await new Promise<void>((resolve, reject) => {
      opening.onsuccess = () => {
        opening.result.close();
        resolve();
      };
      opening.onerror = () => reject(opening.error);
    });
    const queue = await openQueue(factory);
    const entries = await queue.entries();
    expect(entries.map((entry) => [entry.id, entry.group])).toEqual([
      ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'],
      ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'],
    ]);
    await queue.discardGroup('00000000-0000-4000-8000-000000000001');
    expect((await queue.entries()).map((entry) => entry.id)).toEqual(['00000000-0000-4000-8000-000000000002']);
    queue.close();
  });
});

describe('the catalogue after a synced delete (#192)', () => {
  /** The stand-in endpoint, answering each batch's `catalogue` in turn, as the server does after a batch's deletes (#187). */
  function republishing(catalogue: readonly unknown[], decide?: Decide): FakeEndpoint {
    const server = endpoint(decide);
    let batch = 0;
    const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await server.fetch(url, init);
      const answer = catalogue[batch++];
      if (answer === undefined) return response;
      return Response.json({ ...((await response.json()) as object), catalogue: answer });
    };
    return { ...server, fetch: fake as typeof fetch };
  }

  it('[PUB-16] carries the sync answer\'s catalogue outcome, so the admin can be told whether the public catalogue was updated', async () => {
    for (const catalogue of ['updated', 'stale', 'not-published'] as const) {
      const { queue } = await queueWith(['deleteItem']);
      expect(await replayQueue(queue, { fetch: republishing([catalogue]).fetch })).toEqual({ status: 'synced', applied: 1, pending: 0, catalogue });
    }
  });

  it('[PUB-16] carries the last batch\'s outcome, since each republish publishes everything deleted before it', async () => {
    const stale = await queueWith(['deleteItem', 'deletePhoto', 'test.other']);
    expect(await replayQueue(stale.queue, { fetch: republishing(['updated', 'stale']).fetch, batchSize: 2 })).toMatchObject({ status: 'synced', applied: 3, catalogue: 'stale' });
    const updated = await queueWith(['deleteItem', 'deletePhoto', 'test.other']);
    expect(await replayQueue(updated.queue, { fetch: republishing(['stale', 'updated']).fetch, batchSize: 2 })).toMatchObject({ status: 'synced', catalogue: 'updated' });
    // A later batch that deleted nothing answers no catalogue, and leaves the earlier outcome standing.
    const later = await queueWith(['deleteItem', 'test.other']);
    expect(await replayQueue(later.queue, { fetch: republishing(['stale']).fetch, batchSize: 1 })).toMatchObject({ status: 'synced', applied: 2, catalogue: 'stale' });
  });

  it('[PUB-16] keeps the outcome when the replay stops after the batch that deleted', async () => {
    const { queue } = await queueWith(['deletePhoto', 'test.refused']);
    const decide: Decide = (mutation) => (mutation.name === 'test.refused' ? { id: mutation.id, outcome: 'invalid', issues: [] } : { id: mutation.id, outcome: 'applied', result: null });
    expect(await replayQueue(queue, { fetch: republishing(['stale'], decide).fetch })).toEqual({ status: 'held', applied: 1, pending: 1, catalogue: 'stale' });
  });

  it('[PUB-16] carries no outcome when no batch answered one, or answered one it does not know', async () => {
    const quiet = await queueWith(['test.first']);
    expect(await replayQueue(quiet.queue, { fetch: endpoint().fetch })).not.toHaveProperty('catalogue');
    const odd = await queueWith(['deleteItem']);
    expect(await replayQueue(odd.queue, { fetch: republishing(['maybe']).fetch })).not.toHaveProperty('catalogue');
  });
});
