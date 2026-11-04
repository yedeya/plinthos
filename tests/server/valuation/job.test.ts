import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { NO_COLOR } from '../../../src/db/schema/part-price-quote';
import { BASE_BACKOFF_MS, MAX_RETRIES, MIN_REQUEST_INTERVAL_MS, REQUEST_TIMEOUT_MS } from '../../../src/server/valuation/bricklink';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import {
  createPriceJob,
  DAILY_CALL_CAP,
  FRESH_FOR_MS,
  MIN_REQUEST_MS,
  readPaged,
  STALL_AFTER_MS,
  UNKNOWN_ITEM,
  UNLISTED_BOXES_LOGGED,
  UNREACHABLE_AFTER,
  utcDay,
  type PriceJobInvoker,
} from '../../../src/server/valuation/job';
import { LOT_PAGE } from '../../../src/server/parts/lots';
import { partQuoteKeyOf } from '../../../src/server/valuation/part-quotes';
import { COLLECTIBLE_MINIFIGURES_THEME } from '../../../src/server/valuation/values';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { captureLogger } from '../capture';
import { standInPrices, type FakeAnswer } from './fakes';

/**
 * The price refresh's background job (brief #226, Issue A, [VAL-3], [VAL-4], [VAL-8] to [VAL-10])
 * over the test database, a stand-in BrickLink and a fake invoker that queues the job's
 * invocations, which `drain` then runs one by one as Lambda would. Every set, part, colour, price
 * and item here is made up.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
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
  await fresh.client.query('truncate price_quote, part_price_quote, price_refresh_run, bricklink_call_day, photo, collection_item, lego_set, parts_lot, parts_import cascade');
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  capture = captureLogger();
});

const AT = new Date('2026-11-01T09:00:00.000Z');

/** Stores an item straight in the table, as `saveItem` would have. */
async function item({ topTheme, ...fields }: Partial<typeof schema.collectionItem.$inferInsert> & { kind?: 'SET' | 'MINIFIG' | 'BULK' | 'OTHER'; topTheme?: string }): Promise<void> {
  const kind = fields.kind ?? 'SET';
  if (kind === 'SET') {
    const setNum = fields.setNum ?? '990001-1';
    await fresh.db.insert(schema.legoSet).values({ setNum, name: `Made-up ${setNum}`, theme: 'Made-up', topTheme: topTheme ?? null, year: 2001, numParts: 10, fetchedAt: AT }).onConflictDoNothing();
  }
  await fresh.db.insert(schema.collectionItem).values({
    id: randomUUID(),
    kind,
    setNum: kind === 'SET' ? (fields.setNum ?? '990001-1') : null,
    name: kind === 'SET' ? null : (fields.name ?? 'Made-up figure'),
    condition: 'SEALED',
    description: '',
    quantity: 1,
    storageLocation: 'made-up shelf',
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  });
}

/** Stores a parts import with the given lots, as `importPartsFile` would have. */
async function lots(rows: readonly { itemType: string; itemNo: string; colorId: number; lotCondition: 'N' | 'U'; lotQuantity?: number }[]): Promise<void> {
  const importId = randomUUID();
  await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BSX', currency: null, importedAt: AT, lots: rows.length, quantity: rows.length, totalValue: null });
  await fresh.db.insert(schema.partsLot).values(rows.map((row) => ({ importId, lotQuantity: 1, unitPrice: null, ...row })));
}

/** A fake invoker: it queues the run ids it was given, or refuses when told to. */
function fakeInvoker() {
  const queued: string[] = [];
  const invoked: string[] = [];
  let refuse = false;
  const invoker: PriceJobInvoker = {
    async invoke(runId) {
      invoked.push(runId);
      if (refuse) throw new Error('made-up invoke failure');
      queued.push(runId);
    },
  };
  return {
    invoker,
    queued,
    invoked,
    refuseNext: () => {
      refuse = true;
    },
  };
}

function job(
  answers: Readonly<Record<string, FakeAnswer>>,
  options: { budgetMs?: number; requestMs?: number; start?: Date; during?: (key: string) => Promise<void> } = {},
) {
  const prices = standInPrices(answers, options);
  const invoking = fakeInvoker();
  const service = createPriceJob({ provider: () => prices.provider, invoker: () => invoking.invoker, now: prices.now, log: capture.log, currency: () => 'EUR' });
  const budgetMs = options.budgetMs ?? 13 * 60 * 1000;
  /** Runs every queued invocation, as Lambda would, until none is left. */
  async function drain(limit = 20) {
    const results = [];
    for (let steps = 0; invoking.queued.length > 0 && steps < limit; steps++) {
      const runId = invoking.queued.shift() ?? '';
      results.push(await service.runPriceRefresh(runId, { budgetMs }));
    }
    return results;
  }
  return { ...service, prices, invoking, drain, budgetMs };
}

async function runs() {
  return fresh.db.select().from(schema.priceRefreshRun);
}
async function quotes() {
  return fresh.db.select().from(schema.priceQuote);
}
async function partQuotes() {
  return fresh.db.select().from(schema.partPriceQuote);
}

describe('startPriceRefresh', () => {
  it('[VAL-3] refuses anyone but the signed-in admin, and input other than a scope and every-price, before it records or starts anything', async () => {
    const { startPriceRefresh, invoking, prices } = job({});
    await expect(startPriceRefresh({} as AdminContext, { scope: 'items' })).rejects.toThrow(NotAdminError);
    await expect(startPriceRefresh(admin, { scope: 'sets' } as never)).rejects.toThrow();
    await expect(startPriceRefresh(admin, { scope: 'items', all: 'yes' } as never)).rejects.toThrow();
    await expect(startPriceRefresh(admin, { scope: 'items', runId: randomUUID() } as never)).rejects.toThrow();
    expect(await runs()).toEqual([]);
    expect(invoking.invoked).toEqual([]);
    expect(prices.asked).toEqual([]);
  });

  it('[VAL-3] [VAL-9] records a running run and invokes the job with its id alone; a second press while it runs starts nothing', async () => {
    const { startPriceRefresh, invoking, prices } = job({});
    const started = await startPriceRefresh(admin, { scope: 'parts', all: true });
    expect(started).toMatchObject({ status: 'started', run: { scope: 'parts', all: true, state: 'running', stopReason: null, done: 0, failed: 0 } });
    expect(invoking.invoked).toEqual([started.run?.id]);
    expect(capture.events().find((event) => event.businessEvent === 'price.refresh.started')).toMatchObject({ runId: started.run?.id, scope: 'parts', all: true, requestId: admin.requestId });
    const again = await startPriceRefresh(admin, { scope: 'items' });
    expect(again).toMatchObject({ status: 'busy', run: { id: started.run?.id } });
    expect(await runs()).toHaveLength(1);
    expect(invoking.invoked).toHaveLength(1);
    // Starting never asks BrickLink: the job does.
    expect(prices.asked).toEqual([]);
  });

  it('[VAL-9] the database holds the lease: a second running run is refused however it is written', async () => {
    const row = { scope: 'items' as const, allPrices: false, state: 'running' as const, startedAt: AT, heartbeatAt: AT };
    await fresh.db.insert(schema.priceRefreshRun).values(row);
    await expect(fresh.db.insert(schema.priceRefreshRun).values(row)).rejects.toThrow();
    // Ended runs are not held to it.
    await fresh.db.insert(schema.priceRefreshRun).values({ ...row, state: 'done' });
    await fresh.db.insert(schema.priceRefreshRun).values({ ...row, state: 'stopped', stopReason: 'owner' });
    expect(await runs()).toHaveLength(3);
  });

  it('[VAL-9] a run the job could not be invoked for is stopped with invoke-failed, logged, and frees the lease', async () => {
    const { startPriceRefresh, invoking } = job({});
    invoking.refuseNext();
    const result = await startPriceRefresh(admin, { scope: 'items' });
    expect(result).toMatchObject({ status: 'not-started', run: { state: 'stopped', stopReason: 'invoke-failed' } });
    expect(capture.events().find((event) => event.businessEvent === 'price.refresh.failed')).toMatchObject({ reason: 'invoke-failed' });
    expect(capture.lines.join('\n')).not.toContain('made-up invoke failure');
    const other = job({});
    expect(await other.startPriceRefresh(admin, { scope: 'items' })).toMatchObject({ status: 'started' });
  });
});

describe('the job', () => {
  it('[VAL-2] [VAL-3] asks once for each set by condition and each minifigure with a reference number, and ends the run as done', async () => {
    await item({ setNum: '990001-1', condition: 'SEALED' });
    await item({ setNum: '990001-1', condition: 'SEALED', quantity: 3 });
    await item({ setNum: '990001-1', condition: 'USED_WITH_BOX' });
    await item({ setNum: '990002-1', condition: 'USED_NO_BOX' });
    await item({ kind: 'MINIFIG', refNo: 'mu0001', condition: 'USED_NO_BOX' });
    await item({ kind: 'MINIFIG', refNo: null, condition: 'USED_NO_BOX' });
    await item({ kind: 'BULK', refNo: 'mu-bulk', condition: 'USED_NO_BOX' });
    await lots([{ itemType: 'P', itemNo: '99001', colorId: 5, lotCondition: 'N' }]);
    const { startPriceRefresh, drain, prices, priceRefreshStatus } = job({ 'SET 990001-1 N': { average: 100 }, 'SET 990001-1 U': { average: 60 }, 'SET 990002-1 U': { average: 20 }, 'MINIFIG mu0001 U': { average: 4 } });
    await startPriceRefresh(admin, { scope: 'items' });
    const [step] = await drain();
    expect(step).toMatchObject({ status: 'ended', run: { state: 'done', stopReason: null, done: 4, failed: 0, left: 0 } });
    // The items scope never asks for a parts lot.
    expect([...prices.asked].sort()).toEqual(['MINIFIG mu0001 U', 'SET 990001-1 N', 'SET 990001-1 U', 'SET 990002-1 U']);
    expect((await quotes()).map((quote) => `${quote.itemType} ${quote.itemNo} ${quote.newOrUsed} ${quote.average}`).sort()).toEqual([
      'MINIFIG mu0001 U 4',
      'SET 990001-1 N 100',
      'SET 990001-1 U 60',
      'SET 990002-1 U 20',
    ]);
    expect(await partQuotes()).toEqual([]);
    expect(capture.events().find((event) => event.businessEvent === 'price.refreshed')).toMatchObject({ outcome: 'done', done: 4, failed: 0, left: 0 });
    expect((await priceRefreshStatus(admin)).run).toMatchObject({ state: 'done', done: 4 });
  });

  it('[VAL-2] asks BrickLink for a collectible minifigure by its own number, never by Rebrickable\'s', async () => {
    // Rebrickable numbers a box's figures <box>-<n>, its random bag <box>-0 and its complete series
    // <box>-13; BrickLink numbers them col21-<n>, <box>-1 and <box>-2. A sealed box keeps its own
    // number, and an entry BrickLink has no number for isn't asked for.
    await item({ setNum: '71029-12' });
    await item({ setNum: '71029-0' });
    await item({ setNum: '71029-2', condition: 'USED_NO_BOX' });
    await item({ setNum: '71029-13' });
    await item({ setNum: '6341811-1' });
    await item({ setNum: '71030-14' });
    const { startPriceRefresh, drain, prices } = job({ 'SET col21-12 N': { average: 8 }, 'SET 71029-1 N': { average: 4 }, 'SET col21-2 U': { average: 3 }, 'SET 71029-2 N': { average: 50 }, 'SET 6341811-1 N': { average: 200 } });
    await startPriceRefresh(admin, { scope: 'items' });
    await drain();
    expect([...prices.asked].sort()).toEqual(['SET 6341811-1 N', 'SET 71029-1 N', 'SET 71029-2 N', 'SET col21-12 N', 'SET col21-2 U']);
  });

  it('[VAL-2] asks for nothing of a series the table doesn\'t list but its <box>-1, and logs its box in every step', async () => {
    // 99071 is a made-up series under Collectible Minifigures that MINIFIGURE_SERIES doesn't list (#250).
    const cmf = COLLECTIBLE_MINIFIGURES_THEME;
    await item({ setNum: '99071-2', topTheme: cmf });
    await item({ setNum: '99071-0', topTheme: cmf, condition: 'USED_NO_BOX' });
    await item({ setNum: '99071-1', topTheme: cmf });
    await item({ setNum: '99072-5', topTheme: cmf });
    // A listed box under the theme maps as before, and a set with no top-level theme stored keeps its number.
    await item({ setNum: '71029-12', topTheme: cmf });
    await item({ setNum: '99073-2' });
    const { startPriceRefresh, drain, prices } = job({ 'SET 99071-1 N': { average: 9 }, 'SET col21-12 N': { average: 8 }, 'SET 99073-2 N': { average: 30 } });
    await startPriceRefresh(admin, { scope: 'items' });
    const [step] = await drain();
    expect(step).toMatchObject({ status: 'ended', run: { state: 'done', done: 3, failed: 0, left: 0 } });
    expect([...prices.asked].sort()).toEqual(['SET 99071-1 N', 'SET 99073-2 N', 'SET col21-12 N']);
    const logged = capture.events().filter((event) => event.businessEvent === 'price.refresh.series_unlisted');
    expect(logged).toEqual([expect.objectContaining({ level: 'warn', runId: expect.any(String), boxes: ['99071', '99072'], unlisted: 2 })]);
    // A run with no unlisted series logs none.
    await fresh.client.query("delete from collection_item where set_num like '9907%'");
    capture = captureLogger();
    const again = job({ 'SET col21-12 N': { average: 8 } });
    await again.startPriceRefresh(admin, { scope: 'items', all: true });
    await again.drain();
    expect(capture.events().some((event) => event.businessEvent === 'price.refresh.series_unlisted')).toBe(false);
  });

  it('[VAL-2] names at most UNLISTED_BOXES_LOGGED boxes in one line, and counts them all', async () => {
    const cmf = COLLECTIBLE_MINIFIGURES_THEME;
    for (let index = 0; index < UNLISTED_BOXES_LOGGED + 3; index++) await item({ setNum: `98${String(index).padStart(3, '0')}-2`, topTheme: cmf });
    const { startPriceRefresh, drain, prices } = job({});
    await startPriceRefresh(admin, { scope: 'items' });
    await drain();
    expect(prices.asked).toEqual([]);
    const [line] = capture.events().filter((event) => event.businessEvent === 'price.refresh.series_unlisted');
    expect(line).toMatchObject({ unlisted: UNLISTED_BOXES_LOGGED + 3 });
    expect((line as { boxes: string[] }).boxes).toHaveLength(UNLISTED_BOXES_LOGGED);
  });

  it('[VAL-3] skips a quote asked for in the last 7 days, unless the run asks for every price', async () => {
    await item({ setNum: '990001-1' });
    const first = job({ 'SET 990001-1 N': { average: 100 } });
    await first.startPriceRefresh(admin, { scope: 'items' });
    await first.drain();
    const again = job({ 'SET 990001-1 N': { average: 110 } }, { start: new Date(first.prices.now().getTime() + FRESH_FOR_MS - 60_000) });
    await again.startPriceRefresh(admin, { scope: 'all' });
    expect((await again.drain())[0]).toMatchObject({ status: 'ended', run: { state: 'done', done: 0, left: 0 } });
    expect(again.prices.asked).toEqual([]);
    await again.startPriceRefresh(admin, { scope: 'items', all: true });
    expect((await again.drain())[0]).toMatchObject({ run: { done: 1 } });
    expect((await quotes())[0]?.average).toBe(110);
    const stale = job({ 'SET 990001-1 N': { average: 120 } }, { start: new Date(again.prices.now().getTime() + FRESH_FOR_MS + 60_000) });
    await stale.startPriceRefresh(admin, { scope: 'items' });
    await stale.drain();
    expect((await quotes())[0]?.average).toBe(120);
  });

  it('[VAL-3] [VAL-9] works within its budget, oldest first, then invokes itself for the rest, and asks for nothing twice in a run', async () => {
    const sets = ['990001-1', '990002-1', '990003-1', '990004-1', '990005-1'];
    for (const setNum of sets) await item({ setNum });
    const old = new Date('2026-10-01T00:00:00.000Z');
    await fresh.db.insert(schema.priceQuote).values([
      { itemType: 'SET', itemNo: '990001-1', newOrUsed: 'N', average: 5, sampleSize: 1, currency: 'EUR', source: 'bricklink', fetchedAt: old, attemptedAt: new Date('2026-10-02T00:00:00.000Z') },
      { itemType: 'SET', itemNo: '990002-1', newOrUsed: 'N', average: 5, sampleSize: 1, currency: 'EUR', source: 'bricklink', fetchedAt: old, attemptedAt: old },
    ]);
    // Each request takes 1 s, and one starts only with MIN_REQUEST_MS left: one request a step.
    const { startPriceRefresh, drain, prices, invoking } = job(Object.fromEntries(sets.map((setNum) => [`SET ${setNum} N`, { average: 10 }])), { budgetMs: MIN_REQUEST_MS + 500 });
    const started = await startPriceRefresh(admin, { scope: 'items' });
    const steps = await drain();
    expect(steps.map((step) => step.status)).toEqual(['continued', 'continued', 'continued', 'continued', 'ended']);
    expect(steps[0]).toMatchObject({ run: { done: 1, left: 4 } });
    expect(steps[4]).toMatchObject({ run: { state: 'done', done: 5, left: 0 } });
    expect(prices.asked).toEqual(['SET 990003-1 N', 'SET 990004-1 N', 'SET 990005-1 N', 'SET 990002-1 N', 'SET 990001-1 N']);
    // Every invocation was for the one run, by its id alone.
    expect(new Set(invoking.invoked)).toEqual(new Set([started.run?.id]));
    // Each request got what was left of the step, and never less than the client's own worst case,
    // every attempt's timeout, the backoffs and a slot's wait: the step's budget never cuts a request short (#215).
    for (const budget of prices.budgets) expect(budget).toBeLessThanOrEqual(MIN_REQUEST_MS + 500);
    for (const budget of prices.budgets) expect(budget).toBeGreaterThanOrEqual(MIN_REQUEST_MS);
    const worstCase = (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + BASE_BACKOFF_MS * (2 ** MAX_RETRIES - 1) + MIN_REQUEST_INTERVAL_MS;
    expect(MIN_REQUEST_MS).toBeGreaterThan(worstCase);
    // A whole run with every price: each once, however many steps it takes.
    prices.advance(60_000);
    await startPriceRefresh(admin, { scope: 'items', all: true });
    await drain();
    expect(prices.asked.slice(5).sort()).toEqual(sets.map((setNum) => `SET ${setNum} N`).sort());
  });

  it('[VAL-9] an invocation delivered twice works once, and one for an ended run, or another’s step, does nothing', async () => {
    await item({ setNum: '990001-1' });
    await item({ setNum: '990002-1' });
    const asked: string[] = [];
    let twin: Promise<unknown> | undefined;
    const doubled = job(
      { 'SET 990001-1 N': { average: 1 }, 'SET 990002-1 N': { average: 2 } },
      {
        // While the first delivery works, the same event arrives again.
        during: async (key) => {
          asked.push(key);
          twin ??= doubled.runPriceRefresh(String((await runs())[0]?.id), { budgetMs: doubled.budgetMs });
          expect(await twin).toEqual({ status: 'skipped' });
        },
      },
    );
    const started = await doubled.startPriceRefresh(admin, { scope: 'items' });
    await doubled.drain();
    expect(asked).toEqual(['SET 990001-1 N', 'SET 990002-1 N']);
    // A late duplicate after the run ended asks nothing.
    expect(await doubled.runPriceRefresh(started.run?.id ?? '', { budgetMs: doubled.budgetMs })).toEqual({ status: 'skipped' });
    expect(asked).toHaveLength(2);
    // An id that names no run, or is not an id at all.
    expect(await doubled.runPriceRefresh(randomUUID(), { budgetMs: doubled.budgetMs })).toEqual({ status: 'skipped' });
    await expect(doubled.runPriceRefresh('not-a-run', { budgetMs: doubled.budgetMs })).rejects.toThrow();
  });

  it('[VAL-9] a run whose heartbeat is older than 20 minutes is stalled: shown stopped, logged, and the next run may start', async () => {
    await item({ setNum: '990001-1' });
    const { startPriceRefresh, priceRefreshStatus, prices, invoking, runPriceRefresh, budgetMs } = job({ 'SET 990001-1 N': { average: 1 } });
    const first = await startPriceRefresh(admin, { scope: 'items' });
    // The job never ran: nineteen minutes later the run still runs.
    prices.advance(STALL_AFTER_MS - 60_000);
    expect((await priceRefreshStatus(admin)).run).toMatchObject({ state: 'running' });
    expect(await startPriceRefresh(admin, { scope: 'items' })).toMatchObject({ status: 'busy' });
    prices.advance(2 * 60_000);
    expect((await priceRefreshStatus(admin)).run).toMatchObject({ id: first.run?.id, state: 'stopped', stopReason: 'stalled' });
    expect(capture.events().filter((event) => event.businessEvent === 'price.refresh.failed')).toEqual([expect.objectContaining({ reason: 'stalled', runId: first.run?.id })]);
    const second = await startPriceRefresh(admin, { scope: 'items' });
    expect(second).toMatchObject({ status: 'started' });
    // The stalled run's late invocation does nothing; the new run's does the work.
    expect(await runPriceRefresh(invoking.queued.shift() ?? '', { budgetMs })).toEqual({ status: 'skipped' });
    expect(await runPriceRefresh(invoking.queued.shift() ?? '', { budgetMs })).toMatchObject({ status: 'ended', run: { id: second.run?.id, state: 'done', done: 1 } });
    expect(prices.asked).toEqual(['SET 990001-1 N']);
  });

  it('[VAL-9] a stop ends the run before the next request, and a stop between steps ends it at once', async () => {
    for (const setNum of ['990001-1', '990002-1', '990003-1']) await item({ setNum });
    const answers = { 'SET 990001-1 N': { average: 1 }, 'SET 990002-1 N': { average: 2 }, 'SET 990003-1 N': { average: 3 } };
    let stopped: unknown;
    const running = job(answers, {
      during: async () => {
        stopped ??= await running.stopPriceRefresh(admin);
      },
    });
    await expect(running.stopPriceRefresh({} as AdminContext)).rejects.toThrow(NotAdminError);
    await running.startPriceRefresh(admin, { scope: 'items' });
    const [step] = await running.drain();
    expect(stopped).toMatchObject({ status: 'stopping', run: { state: 'running', stopRequested: true } });
    expect(step).toMatchObject({ status: 'ended', run: { state: 'stopped', stopReason: 'owner', done: 1, left: 2 } });
    expect(running.prices.asked).toHaveLength(1);
    expect(capture.events().find((event) => event.businessEvent === 'price.refreshed')).toMatchObject({ outcome: 'stopped' });
    expect(await running.stopPriceRefresh(admin)).toEqual({ status: 'not-running', run: null });

    // Started, and no step has begun: the stop ends it now, and the job's late invocation does nothing.
    const idle = job(answers, { start: new Date(running.prices.now().getTime() + 1_000) });
    await idle.startPriceRefresh(admin, { scope: 'items' });
    expect(await idle.stopPriceRefresh(admin)).toMatchObject({ status: 'stopped', run: { state: 'stopped', stopReason: 'owner' } });
    expect(await idle.drain()).toEqual([{ status: 'skipped' }]);
    expect(idle.prices.asked).toEqual([]);
  });

  it('[VAL-4] records an unknown item or one failed request on its quote, goes on with the rest, and changes no price it had', async () => {
    await item({ setNum: '990001-1' });
    await item({ setNum: '990002-1' });
    await item({ setNum: '990003-1' });
    const fetchedAt = new Date('2026-09-01T00:00:00.000Z');
    await fresh.db.insert(schema.priceQuote).values({ itemType: 'SET', itemNo: '990002-1', newOrUsed: 'N', average: 42.5, sampleSize: 7, currency: 'EUR', source: 'bricklink', fetchedAt, attemptedAt: fetchedAt });
    const { startPriceRefresh, drain } = job({ 'SET 990001-1 N': null, 'SET 990002-1 N': { refuse: 'timeout' }, 'SET 990003-1 N': { average: 30 } });
    await startPriceRefresh(admin, { scope: 'items' });
    expect((await drain())[0]).toMatchObject({ run: { state: 'done', done: 1, failed: 2, left: 0 } });
    const byNo = new Map((await quotes()).map((quote) => [quote.itemNo, quote]));
    expect(byNo.get('990001-1')).toMatchObject({ average: null, lastError: UNKNOWN_ITEM, fetchedAt: null });
    expect(byNo.get('990002-1')).toMatchObject({ average: 42.5, sampleSize: 7, lastError: 'timeout', fetchedAt });
    expect(byNo.get('990003-1')).toMatchObject({ average: 30, lastError: null });
  });

  it('[VAL-4] stops the run on a refused key with the reason, logs price.refresh.failed with no secret, and keeps every price', async () => {
    await item({ setNum: '990001-1' });
    await item({ setNum: '990002-1' });
    const fetchedAt = new Date('2026-09-01T00:00:00.000Z');
    await fresh.db.insert(schema.priceQuote).values({ itemType: 'SET', itemNo: '990001-1', newOrUsed: 'N', average: 42.5, sampleSize: 7, currency: 'EUR', source: 'bricklink', fetchedAt, attemptedAt: fetchedAt });
    const before = await quotes();
    const { startPriceRefresh, drain, prices, priceRefreshStatus } = job({ 'SET 990001-1 N': { refuse: 'refused-key' }, 'SET 990002-1 N': { refuse: 'refused-key' } });
    await startPriceRefresh(admin, { scope: 'items' });
    expect((await drain())[0]).toMatchObject({ status: 'ended', run: { state: 'stopped', stopReason: 'refused-key', done: 0, failed: 0, left: 2 } });
    expect(prices.asked).toHaveLength(1);
    expect(await quotes()).toEqual(before);
    expect((await priceRefreshStatus(admin)).run).toMatchObject({ stopReason: 'refused-key' });
    expect(capture.events().find((event) => event.businessEvent === 'price.refresh.failed')).toMatchObject({ reason: 'refused-key', done: 0, left: 2 });
    expect(capture.events().some((event) => event.businessEvent === 'price.refreshed')).toBe(false);
    expect(capture.lines.join('\n')).not.toMatch(/consumer|token|secret|oauth/i);
  });

  for (const refuse of ['upstream', 'rate-limited'] as const) {
    it(`[VAL-4] [VAL-9] a ${refuse === 'upstream' ? '5xx' : '429'} cut short only by the step’s end records nothing, stops nothing, and the next step asks again`, async () => {
      await item({ setNum: '990001-1' });
      await item({ setNum: '990002-1' });
      // The second request has 40.5 s of the step left, less than its Retry-After wait would need.
      const { startPriceRefresh, drain, prices } = job(
        { 'SET 990001-1 N': { average: 1 }, 'SET 990002-1 N': { cutBelowMs: MIN_REQUEST_MS + 1_000, refuse, then: { average: 2 } } },
        { budgetMs: MIN_REQUEST_MS + 1_500 },
      );
      await startPriceRefresh(admin, { scope: 'items' });
      const steps = await drain();
      expect(steps.map((step) => step.status)).toEqual(['continued', 'ended']);
      expect(steps[0]).toMatchObject({ run: { state: 'running', done: 1, failed: 0, left: 1 } });
      expect(steps[1]).toMatchObject({ run: { state: 'done', stopReason: null, done: 2, failed: 0, left: 0 } });
      expect(prices.asked).toEqual(['SET 990001-1 N', 'SET 990002-1 N', 'SET 990002-1 N']);
      expect((await quotes()).map((quote) => `${quote.itemNo} ${quote.average} ${quote.lastError}`).sort()).toEqual(['990001-1 1 null', '990002-1 2 null']);
      expect(capture.events().some((event) => event.businessEvent === 'price.refresh.failed')).toBe(false);
    });
  }

  it('[VAL-4] a cut on a step’s first request, which no step could outwait, counts as the failure it is', async () => {
    await item({ setNum: '990001-1' });
    const forever = 24 * 60 * 60 * 1000;
    const down = job({ 'SET 990001-1 N': { cutBelowMs: forever, refuse: 'upstream', then: null } });
    await down.startPriceRefresh(admin, { scope: 'items' });
    expect(await down.drain()).toEqual([expect.objectContaining({ status: 'ended', run: expect.objectContaining({ state: 'done', failed: 1 }) })]);
    expect((await quotes())[0]).toMatchObject({ lastError: 'upstream' });
    const limited = job({ 'SET 990001-1 N': { cutBelowMs: forever, refuse: 'rate-limited', then: null } }, { start: new Date(down.prices.now().getTime() + 60_000) });
    await limited.startPriceRefresh(admin, { scope: 'items' });
    expect(await limited.drain()).toEqual([expect.objectContaining({ run: expect.objectContaining({ state: 'stopped', stopReason: 'rate-limited' }) })]);
  });

  it('[VAL-4] stops as unreachable when request after request fails, and asks a failed quote again at the next run', async () => {
    const sets = ['990001-1', '990002-1', '990003-1', '990004-1', '990005-1'];
    for (const setNum of sets) await item({ setNum });
    const failing = job(Object.fromEntries(sets.map((setNum) => [`SET ${setNum} N`, { refuse: 'upstream' as const }])));
    await failing.startPriceRefresh(admin, { scope: 'items' });
    expect((await failing.drain())[0]).toMatchObject({ run: { state: 'stopped', stopReason: 'unreachable', failed: UNREACHABLE_AFTER, left: sets.length - UNREACHABLE_AFTER } });
    expect(failing.prices.asked).toHaveLength(UNREACHABLE_AFTER);
    const next = job(Object.fromEntries(sets.map((setNum) => [`SET ${setNum} N`, { average: 1 }])), { start: new Date(failing.prices.now().getTime() + 60_000) });
    await next.startPriceRefresh(admin, { scope: 'items' });
    expect((await next.drain())[0]).toMatchObject({ run: { state: 'done', done: sets.length } });
  });
});

describe('the parts lots', () => {
  it('[VAL-8] maps each letter to its BrickLink type, asks a part by its colour and nothing else by one, and a lot of another type not at all', () => {
    const lot = (itemType: string, colorId = 11) => partQuoteKeyOf({ itemType, itemNo: ' 99001 ', colorId, lotCondition: 'U' });
    expect(lot('P')).toEqual({ itemType: 'PART', itemNo: '99001', colorId: 11, newOrUsed: 'U' });
    const types = Object.fromEntries(['M', 'S', 'B', 'G', 'C', 'I', 'O'].map((letter) => [letter, lot(letter)?.itemType]));
    expect(types).toEqual({ M: 'MINIFIG', S: 'SET', B: 'BOOK', G: 'GEAR', C: 'CATALOG', I: 'INSTRUCTION', O: 'ORIGINAL_BOX' });
    for (const letter of ['M', 'S', 'B', 'G', 'C', 'I', 'O']) expect(lot(letter)?.colorId).toBe(NO_COLOR);
    for (const letter of ['X', 'U', '', 'PP', 'constructor', 'toString']) expect(lot(letter)).toBeNull();
  });

  it('[VAL-8] asks once for each lot’s key, however many lots share it, and stores it in part_price_quote by type, number, colour and condition', async () => {
    await item({ setNum: '990001-1' });
    await lots([
      { itemType: 'P', itemNo: '99001', colorId: 5, lotCondition: 'N' },
      { itemType: 'P', itemNo: '99001', colorId: 5, lotCondition: 'N', lotQuantity: 40 },
      { itemType: 'P', itemNo: '99001', colorId: 11, lotCondition: 'N' },
      { itemType: 'P', itemNo: '99001', colorId: 5, lotCondition: 'U' },
      { itemType: 'M', itemNo: 'mu9001', colorId: 0, lotCondition: 'U' },
      { itemType: 'M', itemNo: 'mu9001', colorId: 3, lotCondition: 'U' },
      { itemType: 'S', itemNo: '990009-1', colorId: 0, lotCondition: 'N' },
      { itemType: 'X', itemNo: 'xx1', colorId: 0, lotCondition: 'N' },
    ]);
    const { startPriceRefresh, drain, prices } = job({
      'PART 99001 5 N': { average: 0.12, sampleSize: 900 },
      'PART 99001 11 N': { average: 0.5 },
      'PART 99001 5 U': { average: 0.05 },
      'MINIFIG mu9001 U': { average: 3 },
      'SET 990009-1 N': null,
    });
    await startPriceRefresh(admin, { scope: 'parts' });
    expect((await drain())[0]).toMatchObject({ run: { state: 'done', done: 4, failed: 1, left: 0 } });
    // A part by its colour; anything else without one; no set of the collection in the parts scope.
    expect([...prices.asked].sort()).toEqual(['MINIFIG mu9001 U', 'PART 99001 11 N', 'PART 99001 5 N', 'PART 99001 5 U', 'SET 990009-1 N']);
    expect((await partQuotes()).map((quote) => `${quote.itemType} ${quote.itemNo} ${quote.colorId} ${quote.newOrUsed} ${quote.average} ${quote.lastError}`).sort()).toEqual([
      'MINIFIG mu9001 0 U 3 null',
      'PART 99001 11 N 0.5 null',
      'PART 99001 5 N 0.12 null',
      'PART 99001 5 U 0.05 null',
      `SET 990009-1 0 N null ${UNKNOWN_ITEM}`,
    ]);
    expect(await quotes()).toEqual([]);
    // Everything: the collection's quotes and the parts', each once.
    const all = job({ 'SET 990001-1 N': { average: 9 } }, { start: new Date(prices.now().getTime() + 1_000) });
    await all.startPriceRefresh(admin, { scope: 'all', all: true });
    await all.drain();
    expect(all.prices.asked).toHaveLength(6);
    expect(new Set(all.prices.asked).size).toBe(6);
  });
});

describe('the job’s reads', () => {
  it('[VAL-3] readPaged reads every page of a total order, and stops after the first short one', async () => {
    const rows = Array.from({ length: 2 * 5 + 3 }, (_, index) => index);
    const asked: number[] = [];
    expect(await readPaged(async (offset, limit) => (asked.push(offset), rows.slice(offset, offset + limit)), 5)).toEqual(rows);
    expect(asked).toEqual([0, 5, 10]);
    const exact: number[] = [];
    expect(await readPaged(async (offset, limit) => (exact.push(offset), rows.slice(0, 10).slice(offset, offset + limit)), 5)).toHaveLength(10);
    expect(exact).toEqual([0, 5, 10]);
  });

  it('[VAL-3] [VAL-8] pages the lots’ keys and the stored quotes, skipping and repeating none, and asks for each quote once', async () => {
    const count = LOT_PAGE + 10;
    const itemNo = (index: number) => `p${String(index).padStart(5, '0')}`;
    const keys = Array.from({ length: count }, (_, index) => ({ itemType: 'P', itemNo: itemNo(index), colorId: index % 7, lotCondition: index % 2 === 0 ? ('N' as const) : ('U' as const) }));
    // Every key once, and a few twice, which the distinct read must fold into one.
    const rows = [...keys, ...keys.slice(0, 5), ...keys.slice(count - 5)];
    const importId = randomUUID();
    await fresh.db.insert(schema.partsImport).values({ id: importId, fileFormat: 'BSX', currency: null, importedAt: AT, lots: rows.length, quantity: rows.length, totalValue: null });
    for (let at = 0; at < rows.length; at += 500) await fresh.db.insert(schema.partsLot).values(rows.slice(at, at + 500).map((row) => ({ importId, lotQuantity: 1, unitPrice: null, ...row })));
    // A fresh quote for every key but three, one of them past the first page of lots: those alone are asked for.
    const unquoted = new Set([0, 1001, count - 3]);
    const recently = new Date('2026-11-02T10:00:00.000Z');
    const stored = keys
      .map((key, index) => ({ key, index }))
      .filter(({ index }) => !unquoted.has(index))
      .map(({ key }) => ({ itemType: 'PART' as const, itemNo: key.itemNo, colorId: key.colorId, newOrUsed: key.lotCondition, average: 0.1, sampleSize: 3, currency: 'EUR', source: 'bricklink' as const, fetchedAt: recently, attemptedAt: recently }));
    expect(stored.length).toBeGreaterThan(LOT_PAGE);
    for (let at = 0; at < stored.length; at += 500) await fresh.db.insert(schema.partPriceQuote).values(stored.slice(at, at + 500));
    const answers = Object.fromEntries([...unquoted].map((index) => [`PART ${itemNo(index)} ${index % 7} ${index % 2 === 0 ? 'N' : 'U'}`, { average: 0.2 }]));
    const { startPriceRefresh, drain, prices } = job(answers);
    await startPriceRefresh(admin, { scope: 'parts' });
    // Every read of the lots' keys and of the stored quotes is a page of at most LOT_PAGE rows.
    const query = vi.spyOn(pool, 'query');
    expect((await drain())[0]).toMatchObject({ run: { state: 'done', done: 3, failed: 0, left: 0 } });
    const reads = query.mock.calls.map(([sent]) => (typeof sent === 'string' ? sent : (sent as { text: string }).text)).filter((text) => /from "(parts_lot|part_price_quote)"/.test(text) && text.startsWith('select'));
    query.mockRestore();
    expect(reads.filter((text) => text.includes('"parts_lot"'))).toHaveLength(2);
    expect(reads.filter((text) => text.includes('"part_price_quote"'))).toHaveLength(2);
    for (const text of reads) expect(text).toMatch(/order by .* limit \$\d+( offset \$\d+)?$/);
    expect([...prices.asked].sort()).toEqual(Object.keys(answers).sort());
    expect(await partQuotes()).toHaveLength(count);
  });
});

describe('the daily limit', () => {
  it('[VAL-10] counts every call per UTC day, stops with daily-limit before one would pass 4,500, logs it, and carries on the next day', async () => {
    for (const setNum of ['990001-1', '990002-1', '990003-1']) await item({ setNum });
    const answers = { 'SET 990001-1 N': { average: 1 }, 'SET 990002-1 N': { average: 2 }, 'SET 990003-1 N': { average: 3 } };
    const start = new Date('2026-11-03T23:50:00.000Z');
    await fresh.db.insert(schema.bricklinkCallDay).values({ day: utcDay(start), calls: DAILY_CALL_CAP - 1 });
    const today = job(answers, { start });
    await today.startPriceRefresh(admin, { scope: 'items' });
    expect((await today.drain())[0]).toMatchObject({ run: { state: 'stopped', stopReason: 'daily-limit', done: 1, left: 2 } });
    expect(today.prices.asked).toHaveLength(1);
    const [day] = await fresh.db.select().from(schema.bricklinkCallDay).where(eq(schema.bricklinkCallDay.day, utcDay(start)));
    expect(day?.calls).toBe(DAILY_CALL_CAP);
    expect((await today.priceRefreshStatus(admin)).callsToday).toBe(DAILY_CALL_CAP);
    expect(capture.events().find((event) => event.businessEvent === 'price.refresh.failed')).toMatchObject({ reason: 'daily-limit' });
    // After midnight UTC a new press carries on: the quote already asked for is within the 7 days.
    const tomorrow = job(answers, { start: new Date('2026-11-04T00:05:00.000Z') });
    await tomorrow.startPriceRefresh(admin, { scope: 'items' });
    expect((await tomorrow.drain())[0]).toMatchObject({ run: { state: 'done', done: 2 } });
    expect(tomorrow.prices.asked).toHaveLength(2);
    expect(await tomorrow.priceRefreshStatus(admin)).toMatchObject({ callsToday: 2, dailyLimit: DAILY_CALL_CAP });
  });
});
