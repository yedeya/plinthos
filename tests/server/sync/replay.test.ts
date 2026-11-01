import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { adminOperation, issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { MUTATIONS, syncMutation, syncRegistry } from '../../../src/server/sync/registry';
import { createReplay, MAX_BATCH, payloadHash, type MutationOutcome } from '../../../src/server/sync/replay';
import { db } from '../../../src/server/transaction';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';

// The service core reaches the database through `database()`; here it is a pool over a fresh test
// database, so that two replays can really run at once.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

// Test-only records and mutations (brief #6, decision 19): no production service function
// changes a versioned record until set entry, so these drive the rules. Their tables exist only
// in this file's database, never in the schema or the migrations.
const note = pgTable('sync_test_note', {
  id: uuid('id').primaryKey(),
  version: integer('version').notNull(),
  body: text('body').notNull(),
});
const entry = pgTable('sync_test_entry', {
  id: uuid('id').primaryKey(),
  label: text('label').notNull(),
});

const NoteInput = z.strictObject({ id: z.uuid(), body: z.string().min(1) });
const saveNote = adminOperation(NoteInput, async (_admin, input) => {
  const [saved] = await db()
    .insert(note)
    .values({ id: input.id, version: 1, body: input.body })
    .onConflictDoUpdate({ target: note.id, set: { body: input.body, version: sql`${note.version} + 1` } })
    .returning({ id: note.id, version: note.version });
  return saved;
});

const EntryInput = z.strictObject({ label: z.string().min(1), then: z.enum(['return', 'throw', 'unserializable']).default('return') });
const appendEntry = adminOperation(EntryInput, async (_admin, input) => {
  const id = randomUUID();
  await db().insert(entry).values({ id, label: input.label });
  if (input.then === 'throw') throw new Error('the service function failed after its write');
  // A BigInt can't be stored as JSON, so the record's write fails after the change was made.
  if (input.then === 'unserializable') return { id, count: 1n };
  return { id, label: input.label };
});

const seen: AdminContext[] = [];
const spy = adminOperation(z.strictObject({}), async (admin) => {
  seen.push(admin);
  return { ok: true };
});

const registry = syncRegistry([
  syncMutation({
    name: 'test.saveNote',
    input: NoteInput,
    apply: saveNote,
    currentVersion: async (input) => {
      const [row] = await db().select().from(note).where(eq(note.id, input.id)).for('update');
      return row === undefined ? null : { version: row.version, record: row };
    },
  }),
  syncMutation({ name: 'test.appendEntry', input: EntryInput, apply: appendEntry }),
  syncMutation({ name: 'test.spy', input: z.strictObject({}), apply: spy }),
]);

let fresh: FreshDatabase;
let pool: pg.Pool;
let pooled: NodePgDatabase<typeof schema>;
let admin: AdminContext;

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  await fresh.client.query(`create table sync_test_note (id uuid primary key, version integer not null, body text not null)`);
  await fresh.client.query(`create table sync_test_entry (id uuid primary key, label text not null)`);
  const url = new URL(readDatabaseUrl());
  url.pathname = `/${fresh.client.database ?? ''}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pooled = drizzle(pool, { schema });
  state.db = pooled;
});
afterAll(async () => {
  await pool.end();
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('truncate applied_mutation, sync_test_note, sync_test_entry');
  seen.length = 0;
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
});

function replay() {
  const capture = captureLogger();
  return { ...capture, run: createReplay(registry, { log: capture.log }) };
}

async function count(table: string): Promise<number> {
  const { rows } = await fresh.client.query<{ n: string }>(`select count(*) as n from ${table}`);
  return Number(rows[0]?.n);
}

/** Sends each mutation in a batch of its own, since a batch stops at its first unapplied one ([SYNC-4]). */
async function eachAlone(run: ReturnType<typeof createReplay>, mutations: unknown[]): Promise<MutationOutcome[]> {
  const outcomes: MutationOutcome[] = [];
  for (const mutation of mutations) outcomes.push(...(await run(admin, { mutations: [mutation] })).outcomes);
  return outcomes;
}

const queued = (name: string, input: unknown, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), name, input, ...extra });

describe('the offline-sync replay: only registered service functions', () => {
  it('[SYNC-1] applies a mutation by calling its service function with the session’s AdminContext', async () => {
    const { run } = replay();
    const mutation = queued('test.spy', {});
    const { outcomes } = await run(admin, { mutations: [mutation] });
    expect(outcomes).toEqual([{ id: mutation.id, outcome: 'applied', result: { ok: true } }]);
    expect(seen).toEqual([admin]);
    expect(seen[0]).toBe(admin);
  });

  it('[SYNC-1] refuses, before any mutation runs, a context the session check did not issue', async () => {
    const { run } = replay();
    const forged = { ...admin } as AdminContext;
    await expect(run(forged, { mutations: [queued('test.spy', {})] })).rejects.toBeInstanceOf(NotAdminError);
    expect(seen).toEqual([]);
    expect(await count('applied_mutation')).toBe(0);
  });

  it('[SYNC-1] answers a name no service function is registered under as invalid, and changes nothing', async () => {
    const { run } = replay();
    const names = ['test.unknown', 'constructor', '__proto__', 'toString'];
    const mutations = names.map((name) => queued(name, {}));
    const outcomes = await eachAlone(run, mutations);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(names.map(() => 'invalid'));
    expect(outcomes.map((outcome) => outcome.id)).toEqual(mutations.map((mutation) => mutation.id));
    expect(await count('applied_mutation')).toBe(0);
  });

  it('[SYNC-1] validates the input with the named service function’s own schema, and refuses what it refuses', async () => {
    const { run } = replay();
    const mutations = [
      queued('test.appendEntry', { label: '' }),
      queued('test.appendEntry', { label: 'made-up', extra: 'not in the schema' }),
      queued('test.saveNote', { id: 'not-a-uuid', body: 'made-up' }, { baseVersion: null }),
    ];
    const outcomes = await eachAlone(run, mutations);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['invalid', 'invalid', 'invalid']);
    for (const outcome of outcomes) {
      expect(outcome.outcome === 'invalid' && outcome.issues.every((issue) => issue.startsWith('input'))).toBe(true);
    }
    expect(await count('sync_test_entry')).toBe(0);
    expect(await count('applied_mutation')).toBe(0);
  });

  it('[SYNC-1] refuses a malformed envelope as invalid, naming its id when it has a usable one', async () => {
    const { run } = replay();
    const id = randomUUID();
    const outcomes = await eachAlone(run, [
      { id, name: 'test.spy' },
      { id: 'not-a-uuid', name: 'test.spy', input: {} },
      'not an object',
      { id: randomUUID(), name: 'test.spy', input: {}, sneaky: true },
    ]);
    expect(outcomes.map((outcome) => [outcome.outcome, outcome.id === null ? null : typeof outcome.id])).toEqual([
      ['invalid', 'string'],
      ['invalid', null],
      ['invalid', null],
      ['invalid', 'string'],
    ]);
    // A missing input reaches the schema as undefined, which `z.strictObject({})` refuses.
    expect(outcomes[0]?.id).toBe(id);
    expect(seen).toEqual([]);
  });

  it('[SYNC-1] the production registry holds only registered service functions, none yet in the skeleton (decision 19)', () => {
    expect([...MUTATIONS.keys()]).toEqual([]);
    expect(() => syncRegistry([syncMutation({ name: 'a', input: z.object({}), apply: spy }), syncMutation({ name: 'a', input: z.object({}), apply: spy })])).toThrow(
      /two sync mutations/,
    );
  });

  it('[SYNC-1] refuses a batch that is empty or longer than the limit', async () => {
    const { run } = replay();
    await expect(run(admin, { mutations: [] })).rejects.toThrow();
    await expect(run(admin, { mutations: Array.from({ length: MAX_BATCH + 1 }, () => queued('test.spy', {})) })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('the offline-sync replay: idempotent by the client’s id', () => {
  it('[SYNC-2] a replay of the same id and payload changes nothing and returns the first result', async () => {
    const { run } = replay();
    const mutation = queued('test.appendEntry', { label: 'made-up label' });
    const first = await run(admin, { mutations: [mutation] });
    const second = await run(admin, { mutations: [mutation] });
    const [applied] = first.outcomes;
    expect(applied).toMatchObject({ id: mutation.id, outcome: 'applied', result: { label: 'made-up label' } });
    expect(second.outcomes).toEqual([{ id: mutation.id, outcome: 'already-applied', result: applied?.outcome === 'applied' ? applied.result : undefined }]);
    expect(await count('sync_test_entry')).toBe(1);
    expect(await count('applied_mutation')).toBe(1);
  });

  it('[SYNC-2] the same payload with its keys in another order is the same payload', async () => {
    const { run } = replay();
    const id = randomUUID();
    await run(admin, { mutations: [{ id, name: 'test.appendEntry', input: { label: 'made-up', then: 'return' } }] });
    const { outcomes } = await run(admin, { mutations: [{ input: { then: 'return', label: 'made-up' }, name: 'test.appendEntry', id }] });
    expect(outcomes[0]?.outcome).toBe('already-applied');
    expect(payloadHash({ name: 'n', input: { a: 1, b: [1, { c: 2, d: 3 }] } })).toBe(payloadHash({ name: 'n', input: { b: [1, { d: 3, c: 2 }], a: 1 } }));
  });

  it('[SYNC-2] two replays of one id at the same moment apply it once', async () => {
    const run = createReplay(registry, { log: captureLogger().log });
    const mutation = queued('test.appendEntry', { label: 'made-up' });
    const results = await Promise.all([run(admin, { mutations: [mutation] }), run(admin, { mutations: [mutation] }), run(admin, { mutations: [mutation] })]);
    const outcomes = results.map((result) => result.outcomes[0]?.outcome).sort();
    expect(outcomes).toEqual(['already-applied', 'already-applied', 'applied']);
    expect(await count('sync_test_entry')).toBe(1);
  });

  it('[SYNC-2] a service function that fails after its write leaves neither its change nor the record, so a retry applies it', async () => {
    const { run } = replay();
    const failing = queued('test.appendEntry', { label: 'made-up', then: 'throw' });
    expect((await run(admin, { mutations: [failing] })).outcomes[0]?.outcome).toBe('failed');
    expect(await count('sync_test_entry')).toBe(0);
    expect(await count('applied_mutation')).toBe(0);

    // The same client id, retried once the cause is gone, is applied rather than answered from a record.
    const retried = { ...failing, input: { label: 'made-up' } };
    expect((await run(admin, { mutations: [retried] })).outcomes[0]?.outcome).toBe('applied');
    expect(await count('sync_test_entry')).toBe(1);
  });

  it('[SYNC-2] a record that cannot be written rolls the change back with it, in the same transaction', async () => {
    const { run } = replay();
    const mutation = queued('test.appendEntry', { label: 'made-up', then: 'unserializable' });
    expect((await run(admin, { mutations: [mutation] })).outcomes[0]?.outcome).toBe('failed');
    expect(await count('sync_test_entry')).toBe(0);
    expect(await count('applied_mutation')).toBe(0);
  });

  it('[SYNC-2] the record holds the id, a hash of the payload and the result, never the payload', async () => {
    const { run } = replay();
    const mutation = queued('test.appendEntry', { label: 'a made-up private label' });
    await run(admin, { mutations: [mutation] });
    const { rows } = await fresh.client.query<Record<string, unknown>>('select * from applied_mutation');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: mutation.id, name: 'test.appendEntry', payload_hash: payloadHash(mutation) });
    expect(String(rows[0]?.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the offline-sync replay: conflicts', () => {
  it('[SYNC-3] an id already applied with another payload is a conflict, not applied, with the first result', async () => {
    const { run, events, lines } = replay();
    const id = randomUUID();
    const first = await run(admin, { mutations: [{ id, name: 'test.appendEntry', input: { label: 'made-up first' } }] });
    const { outcomes } = await run(admin, { mutations: [{ id, name: 'test.appendEntry', input: { label: 'a made-up second secret' } }] });
    const firstResult = first.outcomes[0]?.outcome === 'applied' ? first.outcomes[0].result : undefined;
    expect(outcomes).toEqual([{ id, outcome: 'conflict', reason: 'payload', result: firstResult }]);
    expect(await count('sync_test_entry')).toBe(1);

    const conflicts = events().filter((event) => event.businessEvent === 'sync.conflict');
    expect(conflicts).toEqual([expect.objectContaining({ mutationId: id, mutation: 'test.appendEntry', reason: 'payload', requestId: admin.requestId })]);
    expect(lines.join('')).not.toContain('a made-up second secret');
  });

  it('[SYNC-3] a base version that differs from the record’s is a conflict, answered with the server’s version', async () => {
    const { run, events, lines } = replay();
    const noteId = randomUUID();
    const created = await run(admin, { mutations: [queued('test.saveNote', { id: noteId, body: 'made-up v1' }, { baseVersion: null })] });
    expect(created.outcomes[0]).toMatchObject({ outcome: 'applied', result: { id: noteId, version: 1 } });
    const moved = await run(admin, { mutations: [queued('test.saveNote', { id: noteId, body: 'made-up v2' }, { baseVersion: 1 })] });
    expect(moved.outcomes[0]).toMatchObject({ outcome: 'applied', result: { version: 2 } });

    // A device that edited version 1 while offline comes back after version 2 was made.
    const stale = queued('test.saveNote', { id: noteId, body: 'a made-up stale secret' }, { baseVersion: 1 });
    const { outcomes } = await run(admin, { mutations: [stale] });
    expect(outcomes).toEqual([
      { id: stale.id, outcome: 'conflict', reason: 'version', currentVersion: 2, current: { id: noteId, version: 2, body: 'made-up v2' } },
    ]);
    const { rows } = await fresh.client.query<{ version: number; body: string }>('select version, body from sync_test_note');
    expect(rows).toEqual([{ version: 2, body: 'made-up v2' }]);
    // A conflict is not applied, so it leaves no record: the client may resend it, rebased.
    expect(await count('applied_mutation')).toBe(2);

    const conflicts = events().filter((event) => event.businessEvent === 'sync.conflict');
    expect(conflicts).toEqual([expect.objectContaining({ mutationId: stale.id, mutation: 'test.saveNote', reason: 'version' })]);
    expect(lines.join('')).not.toContain('a made-up stale secret');
    expect(conflicts[0]).not.toHaveProperty('input');
  });

  it('[SYNC-3] creating a record that already exists is a conflict, and a versioned mutation needs a base version', async () => {
    const { run } = replay();
    const noteId = randomUUID();
    await run(admin, { mutations: [queued('test.saveNote', { id: noteId, body: 'made-up' }, { baseVersion: null })] });
    // One batch each: a batch stops at its first mutation that is not applied ([SYNC-4]).
    const outcomes = await eachAlone(run, [
      queued('test.saveNote', { id: noteId, body: 'made-up again' }, { baseVersion: null }),
      queued('test.saveNote', { id: noteId, body: 'made-up again' }),
      queued('test.appendEntry', { label: 'made-up' }, { baseVersion: 3 }),
    ]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['conflict', 'invalid', 'invalid']);
    expect(outcomes[0]).toMatchObject({ reason: 'version', currentVersion: 1 });
  });
});

describe('the offline-sync replay: order and outcomes', () => {
  it('[SYNC-4] applies a batch in queue order, each in its own transaction, and already-applied does not stop it', async () => {
    const { run } = replay();
    const noteId = randomUUID();
    const done = queued('test.appendEntry', { label: 'made-up done' });
    await run(admin, { mutations: [done] });

    const batch = [
      queued('test.saveNote', { id: noteId, body: 'made-up first' }, { baseVersion: null }),
      done,
      // It comes after the first in the queue, so it sees the version the first made.
      queued('test.saveNote', { id: noteId, body: 'made-up second' }, { baseVersion: 1 }),
    ];
    const { outcomes } = await run(admin, { mutations: batch });
    expect(outcomes.map((outcome: MutationOutcome) => [outcome.id, outcome.outcome])).toEqual([
      [batch[0]?.id, 'applied'],
      [done.id, 'already-applied'],
      [batch[2]?.id, 'applied'],
    ]);
    const { rows } = await fresh.client.query<{ version: number; body: string }>('select version, body from sync_test_note');
    expect(rows).toEqual([{ version: 2, body: 'made-up second' }]);
    expect(await count('applied_mutation')).toBe(3);
  });

  // Each way a mutation can fail to apply, as the batch's second mutation, with two after it.
  const stoppers = {
    conflict: (noteId: string) => queued('test.saveNote', { id: noteId, body: 'made-up stale' }, { baseVersion: 7 }),
    invalid: () => queued('test.nothing', {}),
    failed: () => queued('test.appendEntry', { label: 'a made-up failing secret', then: 'throw' }),
  } as const;

  for (const [stop, make] of Object.entries(stoppers)) {
    it(`[SYNC-4] stops at the first mutation that is not applied (${stop}): the later ones come back not-attempted, with nothing written`, async () => {
      const { run, events, lines } = replay();
      const noteId = randomUUID();
      await run(admin, { mutations: [queued('test.saveNote', { id: noteId, body: 'made-up v1' }, { baseVersion: null })] });
      const before = await count('applied_mutation');

      const first = queued('test.appendEntry', { label: 'made-up before' });
      const stopper = make(noteId);
      const later = [queued('test.appendEntry', { label: 'made-up after' }), queued('test.saveNote', { id: noteId, body: 'made-up later' }, { baseVersion: 1 })];
      const { outcomes } = await run(admin, { mutations: [first, stopper, ...later] });

      expect(outcomes.map((outcome: MutationOutcome) => [outcome.id, outcome.outcome])).toEqual([
        [first.id, 'applied'],
        [stopper.id, stop],
        [later[0]?.id, 'not-attempted'],
        [later[1]?.id, 'not-attempted'],
      ]);
      expect(outcomes.slice(2)).toEqual(later.map((mutation) => ({ id: mutation.id, outcome: 'not-attempted' })));
      if (stop === 'failed') expect(outcomes[1]).toEqual({ id: stopper.id, outcome: 'failed', requestId: admin.requestId });

      // Only the one before the stop was applied and recorded; nothing after it ran.
      expect(await count('applied_mutation')).toBe(before + 1);
      const { rows } = await fresh.client.query<{ label: string }>('select label from sync_test_entry');
      expect(rows).toEqual([{ label: 'made-up before' }]);
      const notes = await fresh.client.query<{ version: number; body: string }>('select version, body from sync_test_note');
      expect(notes.rows).toEqual([{ version: 1, body: 'made-up v1' }]);

      const failures = events().filter((event) => event.businessEvent === 'sync.mutation.failed');
      expect(failures).toEqual(
        stop === 'failed' ? [expect.objectContaining({ level: 'error', mutationId: stopper.id, mutation: 'test.appendEntry', requestId: admin.requestId })] : [],
      );
      expect(lines.join('')).not.toContain('a made-up failing secret');
    });
  }

  it('[SYNC-4] a malformed mutation stops the batch too, and a later one without a usable id comes back not-attempted with no id', async () => {
    const { run } = replay();
    const { outcomes } = await run(admin, { mutations: ['not an object', queued('test.spy', {}), { id: 'not-a-uuid' }] });
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['invalid', 'not-attempted', 'not-attempted']);
    expect(outcomes[2]?.id).toBeNull();
    expect(seen).toEqual([]);
  });
});
