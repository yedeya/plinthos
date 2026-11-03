import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import { catalogueSettings } from '../../../src/db/schema/catalogue-settings';
import { NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { isCatalogueToken } from '../../../src/server/publish/token';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { anAdmin, deferred, delay, MemoryStore, publisher, PUBLIC_URL, StoreView } from './fakes';

/**
 * `[PUB-6]`: `publishCatalogue` is a typed admin operation that writes the snapshot
 * under `/c/{token}/`, invalidates only that path and logs its businessEvent. `[OPS-6]`: a
 * publish that fails leaves the previous snapshot in place and says so. `[PUB-8]`: publishes that
 * overlap take turns, so the bucket holds one publish's files whole, and a failed one never rolls
 * back one that succeeded (#68).
 */

let fresh: FreshDatabase;
beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
});
afterAll(async () => {
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.db.update(catalogueSettings).set({ publicToken: null, publishLease: null, publishLeaseUntil: null });
});

async function storedToken(): Promise<string | null> {
  const [row] = await fresh.db.select({ publicToken: catalogueSettings.publicToken }).from(catalogueSettings);
  return row?.publicToken ?? null;
}

describe('publishCatalogue', () => {
  it('[PUB-6] refuses anything but an AdminContext the session check issued, before it reads or writes anything', async () => {
    let read = false;
    const { publish, store, invalidations } = publisher(fresh.db, {
      database: () => {
        read = true;
        return fresh.db;
      },
    });
    const forged = { sessionKey: 'made-up', requestId: 'made-up' } as unknown as AdminContext;
    await expect(publish(forged, {})).rejects.toThrow(NotAdminError);
    await expect(publish(undefined as unknown as AdminContext, {})).rejects.toThrow(NotAdminError);
    expect(read).toBe(false);
    expect(store.objects.size).toBe(0);
    expect(invalidations).toEqual([]);
  });

  it('[PUB-6] validates its input with zod: a publish takes no option', async () => {
    const { publish, store } = publisher(fresh.db);
    await expect(publish(anAdmin(), { everything: true } as never)).rejects.toThrow(/unrecognized/i);
    expect(store.objects.size).toBe(0);
  });

  it('[PUB-6] [PUB-7] makes the token on the first publish and writes the snapshot under /c/{token}/ only', async () => {
    const { publish, store } = publisher(fresh.db);
    const result = await publish(anAdmin(), {});
    const token = await storedToken();
    expect(isCatalogueToken(token)).toBe(true);
    expect(result).toEqual({ status: 'published', url: `${PUBLIC_URL}/c/${token}/`, publishedAt: '2026-11-01T12:00:01.000Z' });
    const keys = [...store.objects.keys()];
    expect(keys).toEqual(expect.arrayContaining([`c/${token}/`, `c/${token}/catalogue.json`, `c/${token}/index.html`]));
    for (const key of keys) expect(key.startsWith(`c/${token}/`), key).toBe(true);
    const page = store.objects.get(`c/${token}/index.html`);
    expect(page?.contentType).toBe('text/html; charset=utf-8');
    // `/c/{token}/` itself is the page: S3 has no index document behind CloudFront.
    expect(store.objects.get(`c/${token}/`)?.body).toEqual(page?.body);
    // An empty collection publishes an empty catalogue ([PUB-9]: the texts start empty).
    expect(JSON.parse(Buffer.from(store.objects.get(`c/${token}/catalogue.json`)?.body ?? []).toString())).toEqual({
      format: 3,
      publishedAt: '2026-11-01T12:00:01.000Z',
      introText: '',
      contactText: '',
      items: [],
      parts: null,
    });
  });

  it('[PUB-6] keeps the token on later publishes, and two publishes at once agree on one', async () => {
    const { publish } = publisher(fresh.db);
    const [first, second] = await Promise.all([publish(anAdmin(), {}), publish(anAdmin(), {})]);
    const token = await storedToken();
    expect(first).toMatchObject({ url: `${PUBLIC_URL}/c/${token}/` });
    expect(second).toMatchObject({ url: `${PUBLIC_URL}/c/${token}/` });
    await publish(anAdmin(), {});
    expect(await storedToken()).toBe(token);
  });

  it('[PUB-6] invalidates only the token’s path on the public distribution', async () => {
    const { publish, invalidations } = publisher(fresh.db);
    await publish(anAdmin(), {});
    const token = await storedToken();
    expect(invalidations).toEqual([[`/c/${token}/`, `/c/${token}/*`]]);
  });

  it('[PUB-6] logs catalogue.published with the request id, and never the token', async () => {
    const { publish, events, lines, store } = publisher(fresh.db);
    await publish(anAdmin('request-made-up-7'), {});
    const token = await storedToken();
    expect(events()).toEqual([
      expect.objectContaining({
        level: 'info',
        businessEvent: 'catalogue.published',
        requestId: 'request-made-up-7',
        files: store.objects.size,
        items: 0,
        photos: 0,
      }),
    ]);
    expect(lines.join('')).not.toContain(token);
  });

  it('[PUB-6] [PUB-7] refuses to publish under a stored token that is not one, and writes nothing', async () => {
    await fresh.db.update(catalogueSettings).set({ publicToken: '../../escape' });
    const { publish, store, events } = publisher(fresh.db);
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(store.objects.size).toBe(0);
    expect(events()[0]).toMatchObject({ businessEvent: 'catalogue.publish.failed', stage: 'read' });
  });
});

describe('a publish that fails', () => {
  /** Publishes once, so there is a previous snapshot, and returns the publisher and its state. */
  async function afterOnePublish() {
    const run = publisher(fresh.db);
    await run.publish(anAdmin(), {});
    run.lines.length = 0;
    run.invalidations.length = 0;
    return { ...run, before: run.store.snapshot(), token: (await storedToken()) ?? '' };
  }

  it('[OPS-6] while writing leaves the previous snapshot in place, says so and logs catalogue.publish.failed without the token', async () => {
    const { publish, store, before, events, lines, invalidations, token } = await afterOnePublish();
    store.failPut = store.puts + 2;
    const result = await publish(anAdmin('request-made-up-9'), {});
    expect(result).toEqual({ status: 'failed', requestId: 'request-made-up-9', previousKept: true });
    expect(store.snapshot()).toEqual(before);
    expect(invalidations).toEqual([]);
    expect(events()).toEqual([
      expect.objectContaining({
        level: 'error',
        businessEvent: 'catalogue.publish.failed',
        requestId: 'request-made-up-9',
        stage: 'write',
        previousKept: true,
      }),
    ]);
    // The store's error named the key, and so the token; the log line does not.
    expect(lines.join('')).toContain('[token]');
    expect(lines.join('')).not.toContain(token);
  });

  it('[OPS-6] while invalidating puts the previous snapshot back', async () => {
    const { store, before } = await afterOnePublish();
    const failing = publisher(fresh.db, {
      store: () => store,
      invalidate: async () => {
        throw new Error('Rate exceeded');
      },
    });
    expect(await failing.publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(store.snapshot()).toEqual(before);
    expect(failing.events()[0]).toMatchObject({ businessEvent: 'catalogue.publish.failed', stage: 'invalidate' });
  });

  it('[OPS-6] while reading the database writes nothing at all', async () => {
    const { store, before } = await afterOnePublish();
    const failing = publisher(fresh.db, {
      store: () => store,
      database: () => {
        throw new Error('The database is resuming');
      },
    });
    expect(await failing.publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(store.snapshot()).toEqual(before);
    expect(failing.events()[0]).toMatchObject({ stage: 'read' });
  });

  it('[PUB-6] [OPS-6] logs no token when storing the new one fails, from the query’s parameters or anywhere else (#65)', async () => {
    // The database refuses the first publish's UPDATE, so Drizzle's error carries its parameters,
    // the token just made among them.
    await fresh.client.query(`
      create or replace function refuse_token() returns trigger language plpgsql as
        $$ begin raise exception 'refusing to store a token'; end $$;
      create trigger refuse_token before update on catalogue_settings for each row
        when (new.public_token is distinct from old.public_token) execute function refuse_token();
    `);
    try {
      const { publish, store, events, lines } = publisher(fresh.db);
      expect(await publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
      expect(store.objects.size).toBe(0);
      expect(events()[0]).toMatchObject({ businessEvent: 'catalogue.publish.failed', stage: 'read' });
      // The database's own reason is kept; the query and its parameters are not.
      expect(lines.join('')).toContain('refusing to store a token');
      expect(lines.join('')).not.toMatch(/params/i);
      for (const line of lines) expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
    } finally {
      await fresh.client.query('drop trigger refuse_token on catalogue_settings; drop function refuse_token();');
    }
  });

  it('[OPS-6] while reading the previous snapshot writes nothing at all', async () => {
    const { publish, store, before } = await afterOnePublish();
    store.failGet = true;
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(store.snapshot()).toEqual(before);
  });

  it('[OPS-6] on the very first publish leaves no file behind', async () => {
    const { publish, store } = publisher(fresh.db);
    store.failPut = 3;
    expect(await publish(anAdmin(), {})).toMatchObject({ status: 'failed', previousKept: true });
    expect(store.objects.size).toBe(0);
  });

  it('[OPS-6] says so when the previous snapshot could not be put back', async () => {
    const { publish, store } = await afterOnePublish();
    store.failPut = store.puts + 2;
    store.failRestorePut = true;
    store.failDelete = true;
    const result = await publish(anAdmin(), {});
    expect(result).toMatchObject({ status: 'failed', previousKept: false });
  });
});

describe('publishes that overlap', () => {
  /** Publishes once into a store of its own, so there is a previous snapshot, and returns the store. */
  async function aStoreWithOneSnapshot() {
    const shared = new MemoryStore();
    await publisher(fresh.db, { store: () => shared }).publish(anAdmin(), {});
    return { shared, before: shared.snapshot() };
  }

  async function lease(): Promise<{ publishLease: string | null; publishLeaseUntil: Date | null }> {
    const [row] = await fresh.db
      .select({ publishLease: catalogueSettings.publishLease, publishLeaseUntil: catalogueSettings.publishLeaseUntil })
      .from(catalogueSettings);
    return { publishLease: row?.publishLease ?? null, publishLeaseUntil: row?.publishLeaseUntil ?? null };
  }

  it('[PUB-8] [OPS-6] a publish that fails never rolls back one that overlapped it and succeeded', async () => {
    const { shared, before } = await aStoreWithOneSnapshot();
    // A starts first. Its writes wait until B has read the snapshot as it was, if B can.
    const aStarted = deferred();
    const bRead = deferred();
    const aDone = deferred();
    const aView = new StoreView(shared, {
      beforeGet: async () => aStarted.resolve(),
      beforePut: () => Promise.race([bRead.promise, delay(100)]),
    });
    const bView = new StoreView(shared, { beforeGet: async () => bRead.resolve() });
    const a = publisher(fresh.db, { store: () => aView, now: () => new Date('2026-11-01T13:00:00.000Z') });
    // B's invalidation fails, once A has told its admin that it published.
    const b = publisher(fresh.db, {
      store: () => bView,
      now: () => new Date('2026-11-01T14:00:00.000Z'),
      invalidate: async () => {
        await aDone.promise;
        throw new Error('Rate exceeded');
      },
    });
    const aRun = a.publish(anAdmin('request-made-up-a'), {}).finally(aDone.resolve);
    await aStarted.promise;
    const [aResult, bResult] = await Promise.all([aRun, b.publish(anAdmin('request-made-up-b'), {})]);

    expect(aResult).toMatchObject({ status: 'published', publishedAt: '2026-11-01T13:00:00.000Z' });
    expect(bResult).toMatchObject({ status: 'failed', previousKept: true });
    // The bucket holds every file A wrote, as A wrote it, and nothing else.
    expect(Object.keys(aView.wrote).length).toBeGreaterThanOrEqual(3);
    expect(shared.snapshot()).toEqual(aView.wrote);
    expect(shared.snapshot()).not.toEqual(before);
  });

  it('[PUB-8] two publishes that overlap leave the files of one whole: the one that reported published last', async () => {
    const { shared } = await aStoreWithOneSnapshot();
    // A's last file is slow; B starts reading a moment after A. Without turns, B's files would
    // land between A's.
    const aView = new StoreView(shared, { beforePut: (key) => (key.endsWith('/') ? delay(150) : Promise.resolve()) });
    const bView = new StoreView(shared, { beforeGet: () => delay(30) });
    const a = publisher(fresh.db, { store: () => aView, now: () => new Date('2026-11-01T13:00:00.000Z') });
    const b = publisher(fresh.db, { store: () => bView, now: () => new Date('2026-11-01T14:00:00.000Z') });
    const finished: string[] = [];
    const [aResult, bResult] = await Promise.all([
      a.publish(anAdmin(), {}).finally(() => finished.push('a')),
      b.publish(anAdmin(), {}).finally(() => finished.push('b')),
    ]);

    expect(aResult).toMatchObject({ status: 'published' });
    expect(bResult).toMatchObject({ status: 'published' });
    const last = finished[1] === 'a' ? { view: aView, result: aResult } : { view: bView, result: bResult };
    expect(shared.snapshot()).toEqual(last.view.wrote);
    const catalogue = [...shared.objects].find(([key]) => key.endsWith('catalogue.json'))?.[1];
    expect(JSON.parse(Buffer.from(catalogue?.body ?? []).toString())).toMatchObject({
      publishedAt: last.result.status === 'published' ? last.result.publishedAt : 'not published',
    });
  });

  it('[PUB-8] [OPS-6] a publish that finds another still running waits for it, and says so when it does not end', async () => {
    const { shared, before } = await aStoreWithOneSnapshot();
    const aStarted = deferred();
    const letAGo = deferred();
    const aView = new StoreView(shared, {
      beforeGet: async () => {
        aStarted.resolve();
        await letAGo.promise;
      },
    });
    const a = publisher(fresh.db, { store: () => aView });
    const aRun = a.publish(anAdmin(), {});
    await aStarted.promise;

    const bView = new StoreView(shared);
    let waits = 0;
    const b = publisher(fresh.db, { store: () => bView, sleep: async () => void (waits += 1) });
    const bResult = await b.publish(anAdmin('request-made-up-busy'), {});
    expect(bResult).toEqual({ status: 'failed', requestId: 'request-made-up-busy', previousKept: true, busy: true });
    expect(waits).toBeGreaterThan(0);
    expect(bView.gets).toBe(0);
    expect(shared.snapshot()).toEqual(before);
    expect(b.events()).toEqual([
      expect.objectContaining({ level: 'error', businessEvent: 'catalogue.publish.failed', requestId: 'request-made-up-busy', stage: 'read', previousKept: true }),
    ]);

    letAGo.resolve();
    expect(await aRun).toMatchObject({ status: 'published' });
    // A's turn has ended, so the next publish goes ahead at once.
    expect(await publisher(fresh.db, { store: () => shared, sleep: async () => void (waits += 1000) }).publish(anAdmin(), {})).toMatchObject({
      status: 'published',
    });
    expect(waits).toBeLessThan(1000);
  });

  it('[PUB-8] ends its turn whether it published or failed', async () => {
    const { shared } = await aStoreWithOneSnapshot();
    expect(await lease()).toEqual({ publishLease: null, publishLeaseUntil: null });
    shared.failPut = shared.puts + 1;
    expect(await publisher(fresh.db, { store: () => shared }).publish(anAdmin(), {})).toMatchObject({ status: 'failed' });
    expect(await lease()).toEqual({ publishLease: null, publishLeaseUntil: null });
    const failing = publisher(fresh.db, {
      store: () => shared,
      invalidate: async () => {
        throw new Error('Rate exceeded');
      },
    });
    expect(await failing.publish(anAdmin(), {})).toMatchObject({ status: 'failed' });
    expect(await lease()).toEqual({ publishLease: null, publishLeaseUntil: null });
  });

  it('[PUB-8] still reports published when ending its turn fails, and warns without a businessEvent', async () => {
    const { shared } = await aStoreWithOneSnapshot();
    await fresh.client.query(`
      create or replace function refuse_release() returns trigger language plpgsql as
        $$ begin raise exception 'refusing to end the turn'; end $$;
      create trigger refuse_release before update on catalogue_settings for each row
        when (new.publish_lease is null and old.publish_lease is not null) execute function refuse_release();
    `);
    try {
      const run = publisher(fresh.db, { store: () => shared });
      expect(await run.publish(anAdmin('request-made-up-release'), {})).toMatchObject({ status: 'published' });
      expect(run.events()).toEqual([
        expect.objectContaining({ businessEvent: 'catalogue.published' }),
        expect.objectContaining({ level: 'warn', requestId: 'request-made-up-release' }),
      ]);
      expect(run.events()[1]).not.toHaveProperty('businessEvent');
      for (const line of run.lines) expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
      // The turn is still held, until it runs out.
      expect((await lease()).publishLeaseUntil?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await fresh.client.query('drop trigger refuse_release on catalogue_settings; drop function refuse_release();');
    }
  });

  it('[PUB-8] a turn that a publish never ended runs out on its own', async () => {
    const { shared } = await aStoreWithOneSnapshot();
    const immediately = async () => undefined;
    // A publish whose function was stopped mid-way held its turn a minute ago, and it still runs.
    await fresh.client.query(
      `update catalogue_settings set publish_lease = '00000000-0000-4000-8000-0000000000aa', publish_lease_until = now() + interval '1 minute'`,
    );
    expect(await publisher(fresh.db, { store: () => shared, sleep: immediately }).publish(anAdmin(), {})).toMatchObject({
      status: 'failed',
      busy: true,
    });
    // Once its time is up, the next publish takes the turn.
    await fresh.client.query(`update catalogue_settings set publish_lease_until = now() - interval '1 second'`);
    expect(await publisher(fresh.db, { store: () => shared, sleep: immediately }).publish(anAdmin(), {})).toMatchObject({
      status: 'published',
    });
    expect(await lease()).toEqual({ publishLease: null, publishLeaseUntil: null });
  });
});
