import { issueAdminContext, type AdminContext } from '../../../src/server/auth/admin-context';
import { createPublishCatalogue, type PublishDependencies } from '../../../src/server/publish/publish';
import type { PublishDatabase } from '../../../src/server/publish/projection';
import type { SnapshotObject, SnapshotStore } from '../../../src/server/publish/snapshot';
import { captureLogger } from '../capture';

/** The snapshot bucket in memory, with a switch that fails a chosen call. */
export class MemoryStore implements SnapshotStore {
  readonly objects = new Map<string, SnapshotObject>();
  puts = 0;
  /** Fails the n-th `put` from now on (1-based), or every `delete`/`get` when set. */
  failPut: number | undefined;
  failGet = false;
  failDelete = false;
  failRestorePut = false;

  async get(key: string) {
    if (this.failGet) throw new Error(`GetObject failed for ${key}`);
    return this.objects.get(key) ?? null;
  }

  async put(key: string, object: SnapshotObject) {
    this.puts += 1;
    if (this.failPut !== undefined && this.puts === this.failPut) {
      // An S3 error names the key it failed on, as AccessDenied does.
      throw Object.assign(new Error(`Access Denied for s3:PutObject on ${key}`), { Code: 'AccessDenied' });
    }
    if (this.failRestorePut && this.failPut !== undefined && this.puts > this.failPut) throw new Error(`restore failed for ${key}`);
    this.objects.set(key, { ...object, body: new Uint8Array(object.body) });
  }

  async delete(key: string) {
    if (this.failDelete) throw new Error(`DeleteObject failed for ${key}`);
    this.objects.delete(key);
  }

  /** Every object as text, by key, so two states compare byte for byte. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(
      [...this.objects].map(([key, object]) => [key, `${object.contentType}\n${object.cacheControl}\n${Buffer.from(object.body).toString('latin1')}`]),
    );
  }
}

export const PUBLIC_URL = 'https://catalogue.example.test';

/** An admin as the session check issues one. */
export function anAdmin(requestId = 'request-made-up-1'): AdminContext {
  return issueAdminContext({ sessionKey: '00000000-0000-4000-8000-000000000001', requestId });
}

/** `publishCatalogue` over a database, an in-memory store, a recorded invalidation and a captured log. */
export function publisher(db: PublishDatabase, overrides: Partial<PublishDependencies> = {}) {
  const store = new MemoryStore();
  const invalidations: string[][] = [];
  const { log, lines, events } = captureLogger();
  let clock = Date.parse('2026-11-01T12:00:00.000Z');
  const publish = createPublishCatalogue({
    database: () => db,
    store: () => store,
    invalidate: async (paths) => void invalidations.push([...paths]),
    publicUrl: () => PUBLIC_URL,
    now: () => new Date((clock += 1000)),
    log,
    ...overrides,
  });
  return { publish, store, invalidations, lines, events };
}
