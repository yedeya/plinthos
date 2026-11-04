/**
 * The price refresh as a background job (brief #226, Issue A, [VAL-3], [VAL-4], [VAL-8] to
 * [VAL-10]), as typed service functions (`AGENTS.md` §4):
 *
 * - `startPriceRefresh(admin, { scope, all })`: an `adminOperation`. It records a run, which only
 *   it creates, and invokes the job with the run's id; the owner may close the page.
 * - `runPriceRefresh(runId, { budgetMs })`: one invocation of the job (`./worker.ts`). It does only
 *   what the run's row says: its scope, whether it asks for every price, and whether it is still
 *   running and the owner has not asked it to stop.
 * - `stopPriceRefresh(admin)` and `priceRefreshStatus(admin)`: the admin's **Stop** and the
 *   progress and outcome `/admin` shows ([VAL-11], #229).
 *
 * **The lease ([VAL-9]).** One run at a time is `running`, which a partial unique index holds
 * (`src/db/schema/price-refresh-run.ts`). A running run whose heartbeat is older than
 * `STALL_AFTER_MS` is stalled: whoever looks next (a start, a status, a stop or the job) ends it as
 * stopped with `stalled`, logs `price.refresh.failed`, and frees the lease. One invocation at a
 * time works on a run: it claims the run's step (`step_until`, up to the function's timeout) and
 * works only once it holds it, so a continuation Lambda delivers twice works once, and one
 * delivered after its run ended does nothing.
 *
 * **One step.** An invocation works for at most its budget, about 13 minutes. Before each request
 * it writes the heartbeat and the counts, and reads whether the run is still running and whether
 * the owner asked it to stop; it ends the run on a stop. Every BrickLink request, retries
 * included, is first counted against the UTC day's calls, and a request that would take the day
 * past `DAILY_CALL_CAP` is never sent: the run stops with `daily-limit` ([VAL-10]). Each answer is
 * written as it arrives, outside any transaction. A request is started only with `MIN_REQUEST_MS`
 * of the budget left, longer than the client's own timeouts and retries take, so it is the client
 * that ends a slow request. A request the step's budget still cuts short, such as a retry whose
 * `Retry-After` reaches past the step's end, records nothing and is left for the next step (#215).
 * The job's reads are paged (`readPaged`), so every Data API answer stays under its 1 MB cap. When the budget is spent the
 * invocation hands the step back and invokes the job again for the rest; when nothing is left it
 * ends the run as done. Nothing else ever starts the job ([VAL-3], `AGENTS.md` §3).
 *
 * **The quotes ([VAL-3], [VAL-8]).** A run asks for each quote its scope needs once, oldest first:
 * never asked for, then by when it last was. `items` is every set by BrickLink's number for it
 * (`bricklinkSetNo`), never a set BrickLink has no number for, and every minifigure with a
 * reference number (`quoteKeyOf`); `parts` is every parts lot's key
 * (`partQuoteKeyOf`), once however many lots share it. A quote asked for in the last 7 days is
 * skipped unless the run asks for every price; a quote whose last request failed is asked again;
 * one BrickLink doesn't know waits until it is stale.
 *
 * A set under Rebrickable's Collectible Minifigures theme whose box `MINIFIGURE_SERIES` doesn't list
 * is of a series the table doesn't know yet: but for `<box>-1` it has no number
 * (`unlistedSeriesBox`, `bricklinkSetNo`), and each step that reads the items logs
 * `price.refresh.series_unlisted` with those boxes, so the gap is noticed and the series gets its
 * row ([VAL-2], #250).
 *
 * **Failures ([VAL-4]).** An unknown item or one failed request is recorded on its quote, and the
 * run goes on. A refused key, a rate limit that outlasted the retries, or `UNREACHABLE_AFTER`
 * failures in a row stop the run with the reason, which the run's row keeps. No failure changes a
 * stored price, its sample size or its date.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { collectionItem } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { partPriceQuote } from '../../db/schema/part-price-quote';
import { partsLot } from '../../db/schema/parts';
import { priceQuote } from '../../db/schema/price-quote';
import { bricklinkCallDay, priceRefreshRun, REFRESH_SCOPES, type RefreshScope, type RunState, type StopReason } from '../../db/schema/price-refresh-run';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger as defaultLogger, type Logger } from '../logger';
import { LOT_PAGE } from '../parts/lots';
import { db } from '../transaction';
import { linkedPriceProvider, PriceUnavailable, REQUEST_TIMEOUT_MS, MAX_RETRIES, type PriceGuide, type PriceProvider } from './bricklink';
import { linkedJobInvoker, type PriceJobInvoker } from './invoker';
import { partQuoteKeyOf, partQuoteKeyString, type PartQuoteKey } from './part-quotes';
import { deploymentCurrency, quoteKeyOf, quoteKeyString, unlistedSeriesBox, type QuoteKey } from './values';

export type { PriceJobInvoker } from './invoker';
export type { RefreshScope, RunState, StopReason } from '../../db/schema/price-refresh-run';

/** A quote asked for this recently is not asked for again, unless the run asks for every price ([VAL-3]). */
export const FRESH_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Failures in a row, with no answer between them, after which BrickLink is taken to be unreachable ([VAL-4]). */
export const UNREACHABLE_AFTER = 3;
/** The `last_error` of a quote BrickLink doesn't know: not asked again until the quote is stale. */
export const UNKNOWN_ITEM = 'unknown-item';
/** A running run whose heartbeat is older than this is stalled ([VAL-9]). */
export const STALL_AFTER_MS = 20 * 60 * 1000;
/** BrickLink calls a UTC day may take, below BrickLink's 5,000 ([VAL-10]). */
export const DAILY_CALL_CAP = 4_500;
/** The unlisted series' boxes one `price.refresh.series_unlisted` line names at most (#250). */
export const UNLISTED_BOXES_LOGGED = 20;
/** How long one invocation holds a run's step at most: the function's timeout (`infra/prices.ts`). */
export const STEP_LEASE_MS = 15 * 60 * 1000;
/**
 * A request is started only with this much of the step's budget left: every attempt's timeout and
 * the backoffs between them, so the client ends a slow request before the budget can (#215).
 */
export const MIN_REQUEST_MS = (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + 10_000;

export const StartPriceRefreshInput = z.strictObject({
  /** What to refresh: the sets and minifigures, the parts lots, or both ([VAL-3]). */
  scope: z.enum(REFRESH_SCOPES),
  /** Ask for every price, however recent ([VAL-3]). */
  all: z.boolean().default(false),
});
export type StartPriceRefreshInput = z.input<typeof StartPriceRefreshInput>;

const RunId = z.uuid();

/** A run as the admin sees it: plain values, so a Server Action can answer it. */
export interface PriceRefreshRunView {
  readonly id: string;
  readonly scope: RefreshScope;
  readonly all: boolean;
  readonly state: RunState;
  /** Why it stopped; null while it runs and when it is done. */
  readonly stopReason: StopReason | null;
  readonly stopRequested: boolean;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly finishedAt: string | null;
  /** Quotes fetched with an answer so far. */
  readonly done: number;
  /** Quotes asked for that got no price: unknown to BrickLink, or one request failed. */
  readonly failed: number;
  /** Quotes still to ask for, as of the last heartbeat. */
  readonly left: number;
}

/** What **Refresh prices** answers ([VAL-3]). */
export type StartPriceRefreshResult =
  | { readonly status: 'started'; readonly run: PriceRefreshRunView }
  /** A run is already running: the lease is taken ([VAL-9]). */
  | { readonly status: 'busy'; readonly run: PriceRefreshRunView | null }
  /** The run was recorded but the job could not be invoked; the run is stopped with `invoke-failed`. */
  | { readonly status: 'not-started'; readonly run: PriceRefreshRunView };

/** What **Stop** answers. */
export type StopPriceRefreshResult = { readonly status: 'stopping' | 'stopped'; readonly run: PriceRefreshRunView } | { readonly status: 'not-running'; readonly run: null };

/** What `/admin` shows of the refresh ([VAL-10], [VAL-11]). */
export interface PriceRefreshStatus {
  /** The latest run, running or ended; null before the first. */
  readonly run: PriceRefreshRunView | null;
  /** BrickLink calls made so far today, UTC. */
  readonly callsToday: number;
  readonly dailyLimit: number;
}

/** What one invocation of the job did. */
export type RunStepResult =
  /** The run is not running, or another invocation holds its step: nothing was done. */
  | { readonly status: 'skipped' }
  /** The budget was spent: the job was invoked again for the rest. */
  | { readonly status: 'continued'; readonly run: PriceRefreshRunView }
  | { readonly status: 'ended'; readonly run: PriceRefreshRunView };

export interface PriceJobDependencies {
  readonly provider: () => PriceProvider;
  readonly invoker: () => PriceJobInvoker;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly currency?: () => string;
}

type Pending =
  | { readonly kind: 'item'; readonly key: QuoteKey; readonly id: string; readonly attemptedAt: Date | null }
  | { readonly kind: 'part'; readonly key: PartQuoteKey; readonly id: string; readonly attemptedAt: Date | null };

interface QuoteState {
  readonly currency: string;
  readonly attemptedAt: Date;
  readonly lastError: string | null;
}

type RunRow = typeof priceRefreshRun.$inferSelect;

function view(row: RunRow): PriceRefreshRunView {
  return {
    id: row.id,
    scope: row.scope,
    all: row.allPrices,
    state: row.state,
    stopReason: row.stopReason,
    stopRequested: row.stopRequested,
    startedAt: row.startedAt.toISOString(),
    heartbeatAt: row.heartbeatAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    done: row.done,
    failed: row.failed,
    left: row.left,
  };
}

/**
 * Reads every row of a query in pages of `LOT_PAGE`, so each Data API answer stays under its 1 MB
 * cap for any inventory the import accepts, up to `MAX_LOTS` lots (`src/server/parts/lots.ts`).
 * `page` must order by a total order, its unique key, so no row is skipped or repeated.
 */
export async function readPaged<Row>(page: (offset: number, limit: number) => Promise<Row[]>, size: number = LOT_PAGE): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += size) {
    const next = await page(offset, size);
    rows.push(...next);
    if (next.length < size) return rows;
  }
}

/** The UTC midnight of an instant: the day BrickLink's calls are counted in ([VAL-10]). */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Builds the job's service functions; deployed code uses `priceJob` below, and the worker its own. */
export function createPriceJob(dependencies: PriceJobDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;
  const currency = dependencies.currency ?? (() => deploymentCurrency());

  /** Ends every running run whose heartbeat is stale, as stopped with `stalled` ([VAL-9]). */
  async function settleStalled(at: Date): Promise<void> {
    const stalled = await db()
      .update(priceRefreshRun)
      .set({ state: 'stopped', stopReason: 'stalled', finishedAt: at, stepUntil: null })
      .where(and(eq(priceRefreshRun.state, 'running'), lt(priceRefreshRun.heartbeatAt, new Date(at.getTime() - STALL_AFTER_MS))))
      .returning();
    for (const run of stalled) {
      log.warn(
        { businessEvent: 'price.refresh.failed', reason: 'stalled', runId: run.id, scope: run.scope, all: run.allPrices, done: run.done, failed: run.failed, left: run.left },
        'A price refresh stopped reporting and is taken as stalled. Every stored price is kept.',
      );
    }
  }

  /** Ends a running run, and logs how; answers it, or null when it had already ended. */
  async function endRun(id: string, reason: StopReason | null, counts: { done: number; failed: number; left: number }, extra: Record<string, unknown> = {}): Promise<RunRow | null> {
    const at = now();
    const [ended] = await db()
      .update(priceRefreshRun)
      .set({ state: reason === null ? 'done' : 'stopped', stopReason: reason, finishedAt: at, heartbeatAt: at, stepUntil: null, ...counts })
      .where(and(eq(priceRefreshRun.id, id), eq(priceRefreshRun.state, 'running')))
      .returning();
    if (ended === undefined) return null;
    const fields = { runId: id, scope: ended.scope, all: ended.allPrices, ...counts, ...extra };
    if (reason === null) {
      log.info({ businessEvent: 'price.refreshed', outcome: 'done', ...fields }, 'A price refresh finished.');
    } else if (reason === 'owner') {
      log.info({ businessEvent: 'price.refreshed', outcome: 'stopped', ...fields }, 'A price refresh stopped, as the owner asked.');
    } else {
      log.warn({ businessEvent: 'price.refresh.failed', reason, ...fields }, 'A price refresh stopped before it was done. Every stored price is kept.');
    }
    return ended;
  }

  async function latestRun(): Promise<RunRow | null> {
    const [row] = await db().select().from(priceRefreshRun).orderBy(desc(priceRefreshRun.startedAt)).limit(1);
    return row ?? null;
  }

  /** Whether a quote is still to ask for in this run ([VAL-3], [VAL-4]). */
  function needed(quote: QuoteState | undefined, runStart: Date, all: boolean, deployed: string): boolean {
    if (quote === undefined) return true;
    // Never twice in one run: what this run asked for is at or after its start.
    if (quote.attemptedAt.getTime() >= runStart.getTime()) return false;
    const stale = quote.attemptedAt.getTime() < runStart.getTime() - FRESH_FOR_MS;
    // A request that failed is tried again at the next run; an item BrickLink doesn't know waits until it is stale.
    const failed = quote.lastError !== null && quote.lastError !== UNKNOWN_ITEM;
    return all || stale || failed || quote.currency !== deployed;
  }

  /** The quotes the run still needs, oldest first: never asked for, then by when they last were. */
  async function pendingQuotes(runId: string, scope: RefreshScope, runStart: Date, all: boolean, deployed: string): Promise<Pending[]> {
    const pending: Pending[] = [];
    if (scope === 'items' || scope === 'all') {
      const items = await db()
        .select({ kind: collectionItem.kind, condition: collectionItem.condition, setNum: collectionItem.setNum, refNo: collectionItem.refNo, topTheme: legoSet.topTheme })
        .from(collectionItem)
        .leftJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum))
        .where(inArray(collectionItem.kind, ['SET', 'MINIFIG']));
      const keys = new Map<string, QuoteKey>();
      const unlisted = new Set<string>();
      for (const item of items) {
        const key = quoteKeyOf(item);
        if (key !== null) keys.set(quoteKeyString(key), key);
        const box = item.kind === 'SET' && item.setNum !== null ? unlistedSeriesBox(item.setNum, item.topTheme) : null;
        if (box !== null) unlisted.add(box);
      }
      if (unlisted.size > 0) {
        // A series the table doesn't know yet: its figures get no quote until it has a row ([VAL-2], #250).
        const boxes = [...unlisted].sort();
        log.warn(
          { businessEvent: 'price.refresh.series_unlisted', runId, boxes: boxes.slice(0, UNLISTED_BOXES_LOGGED), unlisted: boxes.length },
          'Collectible minifigures of a series MINIFIGURE_SERIES does not list were not asked for: the series needs a row.',
        );
      }
      if (keys.size > 0) {
        const stored = await readPaged((offset, limit) =>
          db()
            .select({
              itemType: priceQuote.itemType,
              itemNo: priceQuote.itemNo,
              newOrUsed: priceQuote.newOrUsed,
              currency: priceQuote.currency,
              attemptedAt: priceQuote.attemptedAt,
              lastError: priceQuote.lastError,
            })
            .from(priceQuote)
            // The unique key, so the order is total and no page skips or repeats a row.
            .orderBy(asc(priceQuote.itemType), asc(priceQuote.itemNo), asc(priceQuote.newOrUsed))
            .limit(limit)
            .offset(offset),
        );
        const quotes = new Map(stored.map((row) => [quoteKeyString(row), row]));
        for (const [id, key] of keys) {
          const quote = quotes.get(id);
          if (needed(quote, runStart, all, deployed)) pending.push({ kind: 'item', key, id: `item\u0000${id}`, attemptedAt: quote?.attemptedAt ?? null });
        }
      }
    }
    if (scope === 'parts' || scope === 'all') {
      const lots = await readPaged((offset, limit) =>
        db()
          .selectDistinct({ itemType: partsLot.itemType, itemNo: partsLot.itemNo, colorId: partsLot.colorId, lotCondition: partsLot.lotCondition })
          .from(partsLot)
          // Every selected column, so the order of the distinct rows is total.
          .orderBy(asc(partsLot.itemType), asc(partsLot.itemNo), asc(partsLot.colorId), asc(partsLot.lotCondition))
          .limit(limit)
          .offset(offset),
      );
      const keys = new Map<string, PartQuoteKey>();
      for (const lot of lots) {
        const key = partQuoteKeyOf(lot);
        if (key !== null) keys.set(partQuoteKeyString(key), key);
      }
      if (keys.size > 0) {
        const stored = await readPaged((offset, limit) =>
          db()
            .select({
              itemType: partPriceQuote.itemType,
              itemNo: partPriceQuote.itemNo,
              colorId: partPriceQuote.colorId,
              newOrUsed: partPriceQuote.newOrUsed,
              currency: partPriceQuote.currency,
              attemptedAt: partPriceQuote.attemptedAt,
              lastError: partPriceQuote.lastError,
            })
            .from(partPriceQuote)
            // The unique key, so the order is total and no page skips or repeats a row.
            .orderBy(asc(partPriceQuote.itemType), asc(partPriceQuote.itemNo), asc(partPriceQuote.colorId), asc(partPriceQuote.newOrUsed))
            .limit(limit)
            .offset(offset),
        );
        const quotes = new Map(stored.map((row) => [partQuoteKeyString(row), row]));
        for (const [id, key] of keys) {
          const quote = quotes.get(id);
          if (needed(quote, runStart, all, deployed)) pending.push({ kind: 'part', key, id: `part\u0000${id}`, attemptedAt: quote?.attemptedAt ?? null });
        }
      }
    }
    return pending.sort((a, b) => (a.attemptedAt?.getTime() ?? -Infinity) - (b.attemptedAt?.getTime() ?? -Infinity) || a.id.localeCompare(b.id));
  }

  /** Stores an answer: the price, its sample size and its date, and no error. */
  async function storeAnswer(quote: Pending, answer: PriceGuide, at: Date): Promise<void> {
    const fields = { average: answer.average, sampleSize: answer.sampleSize, currency: answer.currency, source: 'bricklink' as const, fetchedAt: at, attemptedAt: at, lastError: null };
    if (quote.kind === 'item') {
      await db()
        .insert(priceQuote)
        .values({ ...quote.key, ...fields })
        .onConflictDoUpdate({ target: [priceQuote.itemType, priceQuote.itemNo, priceQuote.newOrUsed], set: fields });
    } else {
      await db()
        .insert(partPriceQuote)
        .values({ ...quote.key, ...fields })
        .onConflictDoUpdate({ target: [partPriceQuote.itemType, partPriceQuote.itemNo, partPriceQuote.colorId, partPriceQuote.newOrUsed], set: fields });
    }
  }

  /** Records a failure on the quote, changing no price, sample size or date it had ([VAL-4]). */
  async function storeFailure(quote: Pending, reason: string, at: Date, deployed: string): Promise<void> {
    const fresh = { average: null, sampleSize: 0, currency: deployed, source: 'bricklink' as const, fetchedAt: null, attemptedAt: at, lastError: reason };
    if (quote.kind === 'item') {
      await db()
        .insert(priceQuote)
        .values({ ...quote.key, ...fresh })
        .onConflictDoUpdate({ target: [priceQuote.itemType, priceQuote.itemNo, priceQuote.newOrUsed], set: { attemptedAt: at, lastError: reason } });
    } else {
      await db()
        .insert(partPriceQuote)
        .values({ ...quote.key, ...fresh })
        .onConflictDoUpdate({ target: [partPriceQuote.itemType, partPriceQuote.itemNo, partPriceQuote.colorId, partPriceQuote.newOrUsed], set: { attemptedAt: at, lastError: reason } });
    }
  }

  /** Counts one BrickLink call against the UTC day; false, and nothing counted, when the day is at the cap ([VAL-10]). */
  async function countCall(): Promise<boolean> {
    const day = utcDay(now());
    const counted = await db()
      .insert(bricklinkCallDay)
      .values({ day, calls: 1 })
      .onConflictDoUpdate({ target: bricklinkCallDay.day, set: { calls: sql`${bricklinkCallDay.calls} + 1` }, setWhere: sql`${bricklinkCallDay.calls} < ${DAILY_CALL_CAP}` })
      .returning({ calls: bricklinkCallDay.calls });
    return counted.length > 0;
  }

  async function callsToday(): Promise<number> {
    const [row] = await db().select({ calls: bricklinkCallDay.calls }).from(bricklinkCallDay).where(eq(bricklinkCallDay.day, utcDay(now())));
    return row?.calls ?? 0;
  }

  const startPriceRefresh = adminOperation(StartPriceRefreshInput, async (admin, input): Promise<StartPriceRefreshResult> => {
    const at = now();
    await settleStalled(at);
    const [created] = await db()
      .insert(priceRefreshRun)
      .values({ id: randomUUID(), scope: input.scope, allPrices: input.all, state: 'running', startedAt: at, heartbeatAt: at })
      // The lease's index refuses a second running run, however two presses race ([VAL-9]).
      .onConflictDoNothing()
      .returning();
    if (created === undefined) {
      const running = await latestRun();
      return { status: 'busy', run: running === null ? null : view(running) };
    }
    log.info({ businessEvent: 'price.refresh.started', requestId: admin.requestId, runId: created.id, scope: created.scope, all: created.allPrices }, 'A price refresh started.');
    try {
      await dependencies.invoker().invoke(created.id);
    } catch {
      // The error is not logged: an SDK error can carry the function's ARN, which holds the account id.
      const ended = await endRun(created.id, 'invoke-failed', { done: 0, failed: 0, left: 0 }, { requestId: admin.requestId });
      return { status: 'not-started', run: view(ended ?? created) };
    }
    return { status: 'started', run: view(created) };
  });

  async function stopPriceRefresh(admin: AdminContext): Promise<StopPriceRefreshResult> {
    assertAdmin(admin);
    const at = now();
    await settleStalled(at);
    const [asked] = await db().update(priceRefreshRun).set({ stopRequested: true }).where(eq(priceRefreshRun.state, 'running')).returning();
    if (asked === undefined) return { status: 'not-running', run: null };
    log.info({ requestId: admin.requestId, runId: asked.id }, 'The owner asked the price refresh to stop.');
    // No invocation works on it: between two steps, or not begun. It ends now, and a late one finds it ended.
    if (asked.stepUntil === null || asked.stepUntil.getTime() < at.getTime()) {
      const ended = await endRun(asked.id, 'owner', { done: asked.done, failed: asked.failed, left: asked.left }, { requestId: admin.requestId });
      if (ended !== null) return { status: 'stopped', run: view(ended) };
    }
    return { status: 'stopping', run: view(asked) };
  }

  async function priceRefreshStatus(admin: AdminContext): Promise<PriceRefreshStatus> {
    assertAdmin(admin);
    await settleStalled(now());
    const [run, calls] = [await latestRun(), await callsToday()];
    return { run: run === null ? null : view(run), callsToday: calls, dailyLimit: DAILY_CALL_CAP };
  }

  /** One invocation of the job, for one run, for at most `budgetMs` ([VAL-9]). */
  async function runPriceRefresh(runId: string, options: { readonly budgetMs: number }): Promise<RunStepResult> {
    const id = RunId.parse(runId);
    const started = now();
    const deadline = started.getTime() + options.budgetMs;
    await settleStalled(started);
    // The step: only a running run, and only when no other invocation holds it.
    const [run] = await db()
      .update(priceRefreshRun)
      .set({ stepUntil: new Date(started.getTime() + STEP_LEASE_MS), heartbeatAt: started })
      .where(
        and(
          eq(priceRefreshRun.id, id),
          eq(priceRefreshRun.state, 'running'),
          or(isNull(priceRefreshRun.stepUntil), lt(priceRefreshRun.stepUntil, started)),
        ),
      )
      .returning();
    if (run === undefined) {
      log.info({ runId: id }, 'A price refresh step found nothing to do: its run has ended, or another step holds it.');
      return { status: 'skipped' };
    }
    const deployed = currency();
    const pending = await pendingQuotes(run.id, run.scope, run.startedAt, run.allPrices, deployed);
    const provider = dependencies.provider();
    let done = run.done;
    let failed = run.failed;
    let processed = 0;
    let inARow = 0;
    let stop: StopReason | 'gone' | undefined;
    let asked = 0;
    const counts = () => ({ done, failed, left: pending.length - processed });
    for (const quote of pending) {
      const remaining = deadline - now().getTime();
      if (remaining < MIN_REQUEST_MS) break;
      // The heartbeat, and whether the run still runs and the owner asked it to stop ([VAL-9]).
      const [beat] = await db()
        .update(priceRefreshRun)
        .set({ heartbeatAt: now(), ...counts() })
        .where(and(eq(priceRefreshRun.id, id), eq(priceRefreshRun.state, 'running')))
        .returning({ stopRequested: priceRefreshRun.stopRequested });
      if (beat === undefined) {
        stop = 'gone';
        break;
      }
      if (beat.stopRequested) {
        stop = 'owner';
        break;
      }
      let answer: PriceGuide | null;
      asked += 1;
      try {
        answer = await provider.priceGuide(quote.key.itemType, quote.key.itemNo, quote.key.newOrUsed, {
          budgetMs: remaining,
          signal: AbortSignal.timeout(remaining),
          admit: countCall,
          // A colour belongs to a part alone ([VAL-8]).
          ...(quote.kind === 'part' && quote.key.itemType === 'PART' ? { colorId: quote.key.colorId } : {}),
        });
      } catch (error) {
        const reason = error instanceof PriceUnavailable ? error.reason : 'upstream';
        if (reason === 'aborted') break;
        // Ended only by what was left of this step, a `Retry-After` past its end included: nothing
        // is recorded, the run goes on, and the next step, with its whole budget, waits and asks
        // again (#215). On a step's first request the whole budget was not enough either, so the
        // failure counts as what it is, and a wait longer than any step can't loop the run.
        if (error instanceof PriceUnavailable && error.budgetCut && asked > 1) break;
        if (reason === 'refused-key' || reason === 'rate-limited' || reason === 'daily-limit') {
          // Not the quote's fault: nothing is recorded on it, and the next run asks for it.
          stop = reason;
          break;
        }
        await storeFailure(quote, reason, now(), deployed);
        failed += 1;
        processed += 1;
        inARow += 1;
        if (inARow >= UNREACHABLE_AFTER) {
          stop = 'unreachable';
          break;
        }
        continue;
      }
      inARow = 0;
      processed += 1;
      if (answer === null) {
        await storeFailure(quote, UNKNOWN_ITEM, now(), deployed);
        failed += 1;
      } else {
        await storeAnswer(quote, answer, now());
        done += 1;
      }
    }

    if (stop === 'gone') {
      log.info({ runId: id }, 'A price refresh step stopped: its run ended while it worked.');
      return { status: 'skipped' };
    }
    if (stop !== undefined || processed === pending.length) {
      const ended = await endRun(id, stop ?? null, counts());
      return ended === null ? { status: 'skipped' } : { status: 'ended', run: view(ended) };
    }
    // The budget is spent: hand the step back, and invoke the job for the rest.
    const [handed] = await db()
      .update(priceRefreshRun)
      .set({ heartbeatAt: now(), stepUntil: null, ...counts() })
      .where(and(eq(priceRefreshRun.id, id), eq(priceRefreshRun.state, 'running')))
      .returning();
    if (handed === undefined) return { status: 'skipped' };
    try {
      await dependencies.invoker().invoke(id);
    } catch {
      const ended = await endRun(id, 'invoke-failed', counts());
      return ended === null ? { status: 'skipped' } : { status: 'ended', run: view(ended) };
    }
    log.info({ runId: id, ...counts() }, 'A price refresh step spent its budget and handed the rest to the next.');
    return { status: 'continued', run: view(handed) };
  }

  return { startPriceRefresh, stopPriceRefresh, priceRefreshStatus, runPriceRefresh };
}

/** The job as the admin's server deploys it: BrickLink through the linked secrets, and the linked job function. */
export const priceJob = createPriceJob({ provider: linkedPriceProvider, invoker: linkedJobInvoker });

export const { startPriceRefresh, stopPriceRefresh, priceRefreshStatus } = priceJob;
