/**
 * The valuation's service functions (brief #207, Issue B, `AGENTS.md` §4): `refreshPrices`, which
 * the **Refresh prices** button on `/admin` calls ([VAL-3], [VAL-4]); `setValueOverride`, the edit
 * form's private override; and `saveValueAdjustments`, the settings page's per-condition
 * adjustments ([VAL-5], [VAL-7]). Each is an `adminOperation`: the admin check, then zod.
 *
 * **A refresh** finds the quotes the items need (`quoteKeyOf`: each set by its set number, each
 * minifigure with a reference number by it, new for `SEALED` and used otherwise), once each. It
 * skips a quote asked for in the last 7 days unless the owner asks for every price, and asks for
 * the rest oldest first, one at a time, until its time budget, `REFRESH_BUDGET_MS`, is spent. It
 * answers how many it did, how many failed and how many are left, and the page calls it again with
 * the `runStartedAt` it answered until none are: within one run, a quote already asked for is never
 * asked for again, so a quote that keeps failing does not hold the run up. It never runs on a
 * schedule or a public view ([VAL-3], `AGENTS.md` §3).
 *
 * - A quote BrickLink doesn't know (null), or one request that timed out or failed upstream, is
 *   recorded on that quote's `last_error`, and the refresh goes on ([VAL-4]).
 * - A refused key, a rate limit that outlasted the retries, or `UNREACHABLE_AFTER` failures in a
 *   row with no answer between them (BrickLink unreachable) stop the call: it answers `stopped`
 *   with the reason and logs `price.refresh.failed`, never a secret.
 * - No failure ever changes a stored price, its sample size or its date ([VAL-4]).
 *
 * Each answered quote is written as it arrives, outside any transaction, so a call cut short by its
 * function's timeout keeps what it did.
 */
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ADJUSTMENT_PCT_RANGE, catalogueSettings } from '../../db/schema/catalogue-settings';
import { collectionItem, MAX_VALUE_OVERRIDE } from '../../db/schema/collection-item';
import { priceQuote } from '../../db/schema/price-quote';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger as defaultLogger, type Logger } from '../logger';
import { db } from '../transaction';
import { linkedPriceProvider, PriceUnavailable, type PriceProvider } from './bricklink';
import { collectionTotals, deploymentCurrency, loadValuation, quoteKeyOf, quoteKeyString, type Adjustments, type CollectionTotals, type CollectionValues, type QuoteKey, type ValuesDatabase } from './values';

/** What one call of `refreshPrices` may spend on BrickLink: well inside the server function's 55 s (`infra/admin.ts`). */
export const REFRESH_BUDGET_MS = 40_000;
/** A request is started only when this much of the budget is left. */
export const MIN_REQUEST_MS = 2_000;
/** A quote asked for this recently is not asked for again, unless the owner asks for every price ([VAL-3]). */
export const FRESH_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** Failures in a row, with no answer between them, after which BrickLink is taken to be unreachable ([VAL-4]). */
export const UNREACHABLE_AFTER = 3;

/** The `last_error` of a quote BrickLink doesn't know: not retried until the quote is stale. */
export const UNKNOWN_ITEM = 'unknown-item';

export const RefreshPricesInput = z.strictObject({
  /** Ask for every price, however recent ([VAL-3]). */
  all: z.boolean().default(false),
  /** The run's start, as the first call answered it: a later call of the same run passes it back. */
  runStartedAt: z.iso.datetime({ offset: true }).optional(),
});
export type RefreshPricesInput = z.input<typeof RefreshPricesInput>;

/** Why a refresh stopped before its budget was spent ([VAL-4]). */
export type RefreshStopReason = 'refused-key' | 'rate-limited' | 'unreachable';

/** What one call of `refreshPrices` answers ([VAL-3]). */
export interface RefreshPricesResult {
  /** Quotes this call fetched with an answer. */
  readonly done: number;
  /** Quotes still to fetch in this run, after this call. */
  readonly left: number;
  /** Quotes this call asked for and got no price for: unknown to BrickLink, or one request failed. */
  readonly failed: number;
  /** Set when the call stopped on a failure of every request: the page says so and stops calling. */
  readonly stopped?: RefreshStopReason;
  /** The run's start, which the page passes back on its next call. */
  readonly runStartedAt: string;
}

export const SetValueOverrideInput = z.strictObject({
  itemId: z.uuid(),
  /** The whole item's value, all of its quantity, to the cent; null takes the override away. */
  amount: z
    .number()
    .finite()
    .min(0)
    .max(MAX_VALUE_OVERRIDE)
    .refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6, { message: 'at most two decimals' })
    .nullable(),
});
export type SetValueOverrideInput = z.input<typeof SetValueOverrideInput>;

const AdjustmentPct = z.number().int().min(ADJUSTMENT_PCT_RANGE.min).max(ADJUSTMENT_PCT_RANGE.max);
export const SaveValueAdjustmentsInput = z.strictObject({ usedWithBoxPct: AdjustmentPct, usedNoBoxPct: AdjustmentPct });
export type SaveValueAdjustmentsInput = z.input<typeof SaveValueAdjustmentsInput>;

export interface ValuationDependencies {
  readonly provider: () => PriceProvider;
  readonly now?: () => Date;
  readonly log?: Logger;
  readonly budgetMs?: number;
  readonly currency?: () => string;
}

/** The collection's values and totals, for the admin's pages ([VAL-7]). */
export interface AdminValues {
  readonly values: CollectionValues;
  readonly totals: CollectionTotals;
}

interface Pending {
  readonly key: QuoteKey;
  /** When it was last asked for; null for a quote never asked for. */
  readonly attemptedAt: Date | null;
}

/** Builds the valuation's service functions; deployed code uses the ones below. */
export function createValuationService(dependencies: ValuationDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;
  const budgetMs = dependencies.budgetMs ?? REFRESH_BUDGET_MS;
  const currency = dependencies.currency ?? (() => deploymentCurrency());

  /** The quotes this run still needs, oldest first: never asked for, then by when they last were. */
  async function pendingQuotes(runStart: Date, all: boolean, deployed: string): Promise<Pending[]> {
    const items = await db()
      .select({ kind: collectionItem.kind, condition: collectionItem.condition, setNum: collectionItem.setNum, refNo: collectionItem.refNo })
      .from(collectionItem)
      .where(inArray(collectionItem.kind, ['SET', 'MINIFIG']));
    const keys = new Map<string, QuoteKey>();
    for (const item of items) {
      const key = quoteKeyOf(item);
      if (key !== null) keys.set(quoteKeyString(key), key);
    }
    if (keys.size === 0) return [];
    const stored = await db()
      .select({
        itemType: priceQuote.itemType,
        itemNo: priceQuote.itemNo,
        newOrUsed: priceQuote.newOrUsed,
        currency: priceQuote.currency,
        attemptedAt: priceQuote.attemptedAt,
        lastError: priceQuote.lastError,
      })
      .from(priceQuote);
    const quotes = new Map(stored.map((row) => [quoteKeyString(row), row]));
    const staleBefore = runStart.getTime() - FRESH_FOR_MS;
    const pending: Pending[] = [];
    for (const [id, key] of keys) {
      const quote = quotes.get(id);
      if (quote === undefined) {
        pending.push({ key, attemptedAt: null });
        continue;
      }
      // Never twice in one run: what this run asked for is at or after its start.
      const beforeRun = quote.attemptedAt.getTime() < runStart.getTime();
      const stale = quote.attemptedAt.getTime() < staleBefore;
      // A request that failed is tried again at the next run; an item BrickLink doesn't know waits until it is stale.
      const failed = quote.lastError !== null && quote.lastError !== UNKNOWN_ITEM;
      const otherCurrency = quote.currency !== deployed;
      if (beforeRun && (all || stale || failed || otherCurrency)) pending.push({ key, attemptedAt: quote.attemptedAt });
    }
    return pending.sort(
      (a, b) => (a.attemptedAt?.getTime() ?? -Infinity) - (b.attemptedAt?.getTime() ?? -Infinity) || quoteKeyString(a.key).localeCompare(quoteKeyString(b.key)),
    );
  }

  /** Stores an answer: the price, its sample size and its date, and no error. */
  async function storeAnswer(key: QuoteKey, answer: { average: number | null; sampleSize: number; currency: string }, at: Date): Promise<void> {
    const fields = { average: answer.average, sampleSize: answer.sampleSize, currency: answer.currency, source: 'bricklink' as const, fetchedAt: at, attemptedAt: at, lastError: null };
    await db()
      .insert(priceQuote)
      .values({ ...key, ...fields })
      .onConflictDoUpdate({ target: [priceQuote.itemType, priceQuote.itemNo, priceQuote.newOrUsed], set: fields });
  }

  /** Records a failure on the quote, changing no price, sample size or date it had ([VAL-4]). */
  async function storeFailure(key: QuoteKey, reason: string, at: Date, deployed: string): Promise<void> {
    await db()
      .insert(priceQuote)
      .values({ ...key, average: null, sampleSize: 0, currency: deployed, source: 'bricklink', fetchedAt: null, attemptedAt: at, lastError: reason })
      .onConflictDoUpdate({ target: [priceQuote.itemType, priceQuote.itemNo, priceQuote.newOrUsed], set: { attemptedAt: at, lastError: reason } });
  }

  const refreshPrices = adminOperation(RefreshPricesInput, async (admin, input): Promise<RefreshPricesResult> => {
    const started = now();
    const deadline = started.getTime() + budgetMs;
    // A run's start is never later than this call's.
    const given = input.runStartedAt === undefined ? started : new Date(input.runStartedAt);
    const runStart = given.getTime() > started.getTime() ? started : given;
    const deployed = currency();
    const pending = await pendingQuotes(runStart, input.all, deployed);
    const provider = dependencies.provider();
    let done = 0;
    let failed = 0;
    let inARow = 0;
    let stopped: RefreshStopReason | undefined;
    for (const { key } of pending) {
      const remaining = deadline - now().getTime();
      if (remaining < MIN_REQUEST_MS) break;
      let answer: Awaited<ReturnType<PriceProvider['priceGuide']>>;
      try {
        answer = await provider.priceGuide(key.itemType, key.itemNo, key.newOrUsed, { budgetMs: remaining, signal: AbortSignal.timeout(remaining) });
      } catch (error) {
        const reason = error instanceof PriceUnavailable ? error.reason : 'upstream';
        if (reason === 'aborted') break;
        if (reason === 'refused-key' || reason === 'rate-limited') {
          // Not the quote's fault: nothing is recorded on it, and it is asked for again next run.
          stopped = reason;
          break;
        }
        await storeFailure(key, reason, now(), deployed);
        failed += 1;
        inARow += 1;
        if (inARow >= UNREACHABLE_AFTER) {
          stopped = 'unreachable';
          break;
        }
        continue;
      }
      inARow = 0;
      if (answer === null) {
        await storeFailure(key, UNKNOWN_ITEM, now(), deployed);
        failed += 1;
      } else {
        await storeAnswer(key, { average: answer.average, sampleSize: answer.sampleSize, currency: answer.currency }, now());
        done += 1;
      }
    }
    const left = pending.length - done - failed;
    const result: RefreshPricesResult = { done, left, failed, runStartedAt: runStart.toISOString(), ...(stopped === undefined ? {} : { stopped }) };
    const counts = { requestId: admin.requestId, all: input.all, done, failed, left };
    if (stopped === undefined) {
      log.info({ businessEvent: 'price.refreshed', ...counts }, 'Refreshed the prices that fitted this call.');
    } else {
      log.warn({ businessEvent: 'price.refresh.failed', reason: stopped, ...counts }, 'The price refresh stopped: BrickLink refused or did not answer. Every stored price is kept.');
    }
    return result;
  });

  const setValueOverride = adminOperation(
    SetValueOverrideInput,
    async (admin, input): Promise<{ readonly status: 'saved' | 'unknown-item'; readonly amount: number | null; readonly currency: string | null }> => {
      const value = input.amount === null ? { manualValueOverride: null, manualValueCurrency: null } : { manualValueOverride: input.amount, manualValueCurrency: currency() };
      // Not part of the item's version: an offline edit of the item never conflicts with it.
      const saved = await db().update(collectionItem).set(value).where(eq(collectionItem.id, input.itemId)).returning({ id: collectionItem.id });
      if (saved.length === 0) return { status: 'unknown-item', amount: null, currency: null };
      log.info({ requestId: admin.requestId, itemId: input.itemId, cleared: input.amount === null }, 'Saved an item’s manual value.');
      return { status: 'saved', amount: value.manualValueOverride, currency: value.manualValueCurrency };
    },
  );

  const saveValueAdjustments = adminOperation(SaveValueAdjustmentsInput, async (admin, input): Promise<Adjustments> => {
    const [saved] = await db()
      .update(catalogueSettings)
      .set({ adjustUsedWithBoxPct: input.usedWithBoxPct, adjustUsedNoBoxPct: input.usedNoBoxPct })
      .returning({ usedWithBoxPct: catalogueSettings.adjustUsedWithBoxPct, usedNoBoxPct: catalogueSettings.adjustUsedNoBoxPct });
    if (saved === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
    log.info({ requestId: admin.requestId }, 'Saved the value adjustments.');
    return saved;
  });

  async function readValueAdjustments(admin: AdminContext): Promise<Adjustments> {
    assertAdmin(admin);
    const [row] = await db()
      .select({ usedWithBoxPct: catalogueSettings.adjustUsedWithBoxPct, usedNoBoxPct: catalogueSettings.adjustUsedNoBoxPct })
      .from(catalogueSettings);
    if (row === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
    return row;
  }

  /** Every item's value and the totals per segment, for `/admin` ([VAL-7]). */
  async function readAdminValues(admin: AdminContext): Promise<AdminValues> {
    assertAdmin(admin);
    const { items, values } = await loadValuation(db() as unknown as ValuesDatabase, currency());
    return { values, totals: collectionTotals(items, values.items, values.parts) };
  }

  return { refreshPrices, setValueOverride, saveValueAdjustments, readValueAdjustments, readAdminValues };
}

/** The valuation as deployed: BrickLink through the linked secrets. */
export const valuation = createValuationService({ provider: linkedPriceProvider });

export const { refreshPrices, setValueOverride, saveValueAdjustments, readValueAdjustments, readAdminValues } = valuation;
