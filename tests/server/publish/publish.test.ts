import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../src/db/migrate';
import { catalogueSettings } from '../../../src/db/schema/catalogue-settings';
import { NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { isCatalogueToken } from '../../../src/server/publish/token';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { anAdmin, publisher, PUBLIC_URL } from './fakes';

/**
 * `[PUB-6]`: `publishCatalogue` is a typed admin operation that writes the placeholder snapshot
 * under `/c/{token}/`, invalidates only that path and logs its businessEvent. `[OPS-6]`: a
 * publish that fails leaves the previous snapshot in place and says so.
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
  await fresh.db.update(catalogueSettings).set({ publicToken: null });
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

  it('[PUB-6] validates its input with zod: the placeholder publish takes no option', async () => {
    const { publish, store } = publisher(fresh.db);
    await expect(publish(anAdmin(), { everything: true } as never)).rejects.toThrow(/unrecognized/i);
    expect(store.objects.size).toBe(0);
  });

  it('[PUB-6] [PUB-7] makes the token on the first publish and writes the placeholder under /c/{token}/ only', async () => {
    const { publish, store } = publisher(fresh.db);
    const result = await publish(anAdmin(), {});
    const token = await storedToken();
    expect(isCatalogueToken(token)).toBe(true);
    expect(result).toEqual({ status: 'published', url: `${PUBLIC_URL}/c/${token}/`, publishedAt: '2026-11-01T12:00:01.000Z' });
    expect([...store.objects.keys()].sort()).toEqual([`c/${token}/`, `c/${token}/catalogue.json`, `c/${token}/index.html`]);
    const page = store.objects.get(`c/${token}/index.html`);
    expect(page?.contentType).toBe('text/html; charset=utf-8');
    expect(Buffer.from(page?.body ?? []).toString()).toContain('Nothing is published here yet.');
    // `/c/{token}/` itself is the page: S3 has no index document behind CloudFront.
    expect(store.objects.get(`c/${token}/`)?.body).toEqual(page?.body);
    expect(JSON.parse(Buffer.from(store.objects.get(`c/${token}/catalogue.json`)?.body ?? []).toString())).toEqual({
      format: 1,
      status: 'placeholder',
      publishedAt: '2026-11-01T12:00:01.000Z',
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
    const { publish, events, lines } = publisher(fresh.db);
    await publish(anAdmin('request-made-up-7'), {});
    const token = await storedToken();
    expect(events()).toEqual([
      expect.objectContaining({ level: 'info', businessEvent: 'catalogue.published', requestId: 'request-made-up-7', files: 3 }),
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
