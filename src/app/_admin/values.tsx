'use client';

/**
 * The values on the admin's pages (brief #207, Issue B, [VAL-3], [VAL-4], [VAL-7]), each private to
 * the admin: **Refresh prices** on `/admin`, which calls the guarded `refreshPrices` action again
 * and again until nothing is left, showing its progress and how it ended; the totals per segment;
 * an item's value with its source and date; and the edit form's override. The actions they call
 * are guarded (`../admin/actions.ts`).
 */
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import type { ListedValue } from '../_offline/items';
import { en } from '../messages/en';
import type { CollectionTotals, RefreshPricesInput, RefreshPricesResult, RefreshStopReason, SaveOverrideResult } from './value-data';

/** The most calls one refresh makes: about 200 × 40 s of quotes, far more than BrickLink's daily limit allows. */
export const MAX_REFRESH_CALLS = 200;

/** How a refresh ended, for the page to say. */
export type RefreshOutcome =
  | { readonly kind: 'done'; readonly done: number; readonly failed: number }
  | { readonly kind: 'stopped'; readonly reason: RefreshStopReason; readonly done: number; readonly failed: number; readonly left: number }
  | { readonly kind: 'stalled' | 'failed'; readonly done: number; readonly failed: number };

/**
 * Calls the action until nothing is left ([VAL-3]), passing back the run's start so no quote is
 * asked for twice; stops at the first call that stopped, failed or did nothing. Exported for the
 * tests, which pass a fake action.
 */
export async function runRefresh(
  action: (input: RefreshPricesInput) => Promise<RefreshPricesResult>,
  all: boolean,
  progress: (done: number, left: number) => void = () => undefined,
): Promise<RefreshOutcome> {
  let done = 0;
  let failed = 0;
  let runStartedAt: string | undefined;
  for (let call = 0; call < MAX_REFRESH_CALLS; call++) {
    let result: RefreshPricesResult;
    try {
      result = await action(runStartedAt === undefined ? { all } : { all, runStartedAt });
    } catch {
      return { kind: 'failed', done, failed };
    }
    done += result.done;
    failed += result.failed;
    runStartedAt = result.runStartedAt;
    progress(done + failed, result.left);
    if (result.stopped !== undefined) return { kind: 'stopped', reason: result.stopped, done, failed, left: result.left };
    if (result.left === 0) return { kind: 'done', done, failed };
    if (result.done + result.failed === 0) return { kind: 'stalled', done, failed };
  }
  return { kind: 'stalled', done, failed };
}

export function RefreshOutcomeText({ outcome }: { readonly outcome: RefreshOutcome }) {
  const m = en.values;
  switch (outcome.kind) {
    case 'done':
      return <p role="status">{m.refreshed(outcome.done, outcome.failed)}</p>;
    case 'stopped':
      return (
        <p role="alert">
          {m.stopped[outcome.reason]} {m.stoppedAfter(outcome.done, outcome.left)}
        </p>
      );
    case 'stalled':
      return <p role="alert">{m.stalled}</p>;
    case 'failed':
      return <p role="alert">{m.refreshFailed}</p>;
  }
}

/**
 * Renders the page's server components again with the new values (`router.refresh()`), keeping
 * every client component's state. Mounted only once there is something new to show, so the page's
 * first render, on the server too, never needs the router.
 */
function ShowNewValues({ done }: { readonly done: () => void }) {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
    done();
  }, [router, done]);
  return null;
}

/**
 * **Refresh prices** and **Refresh every price**, with the progress and the outcome ([VAL-3], [VAL-4]).
 * After a run that fetched any price, the page's values render again in place, which keeps this
 * component and so the outcome it shows, a stop's reason included: a full reload would drop it.
 * `showNewValues` replaces that step in the tests.
 */
export function RefreshPrices({
  action,
  showNewValues,
}: {
  readonly action: (input: RefreshPricesInput) => Promise<RefreshPricesResult>;
  readonly showNewValues?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const m = en.values;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [outcome, setOutcome] = useState<RefreshOutcome | null>(null);
  const start = (all: boolean) => {
    if (!navigator.onLine) {
      setStatus(m.needsNetwork);
      return;
    }
    setBusy(true);
    setOutcome(null);
    setStatus(m.refreshing(0, 0));
    void runRefresh(action, all, (done, left) => setStatus(m.refreshing(done, left))).then((ended) => {
      setBusy(false);
      setStatus('');
      setOutcome(ended);
      // New prices: the page's values render again, and the outcome stays.
      if (ended.done > 0) {
        if (showNewValues === undefined) setRefreshing(true);
        else showNewValues();
      }
    });
  };
  return (
    <div className="section" aria-label={m.refresh}>
      <p className="muted">{m.refreshHint}</p>
      <div className="footer__actions">
        <button type="button" className="button" disabled={busy} onClick={() => start(false)}>
          {m.refresh}
        </button>
        <button type="button" className="button button--link" disabled={busy} onClick={() => start(true)}>
          {m.refreshAll}
        </button>
      </div>
      {status === '' ? null : <p role="status">{status}</p>}
      {outcome === null ? null : <RefreshOutcomeText outcome={outcome} />}
      {refreshing ? <ShowNewValues done={() => setRefreshing(false)} /> : null}
    </div>
  );
}

/** An item's value with its source and date, or that it has none ([VAL-7]). */
export function valueText(value: ListedValue | null | undefined): string {
  const m = en.values;
  if (value === null || value === undefined) return m.noValue;
  if (value.source === 'override' || value.asOf === null) return m.fromOverride(value.amount, value.currency);
  return m.fromBrickLink(value.amount, value.currency, value.asOf);
}

/** The totals per segment and overall ([VAL-7]): one amount per currency, and how many have no value. */
export function ValueTotals({ totals }: { readonly totals: CollectionTotals }) {
  const m = en.values;
  const segments = ['sealed', 'used', 'parts', 'all'] as const;
  return (
    <section className="section" aria-label={m.totalsLabel}>
      <h2>{m.title}</h2>
      <dl className="value-totals">
        {segments.map((segment) => {
          const total = totals[segment];
          return (
            <div key={segment}>
              <dt>{m.segment[segment]}</dt>
              <dd>
                {total.amounts.length === 0 ? m.noValue : total.amounts.map(({ amount, currency }) => m.money(amount, currency)).join(' + ')}
                {total.unvalued === 0 ? null : <span className="muted"> · {m.unvalued(total.unvalued)}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="muted">{m.privateHint}</p>
    </section>
  );
}

/** The edit form's private override ([VAL-7]): an amount for the whole item, blank for none. */
export function ValueOverrideForm({
  action,
  amount,
  currency,
  quantity,
  maxAmount,
  current,
}: {
  readonly action: (previous: SaveOverrideResult | null, form: FormData) => Promise<SaveOverrideResult>;
  /** The override as stored, or null. */
  readonly amount: number | null;
  /** The currency a new override is saved in: the deployment's. */
  readonly currency: string;
  readonly quantity: number;
  readonly maxAmount: number;
  /** The item's value now, with its source, or null. */
  readonly current: ListedValue | null;
}) {
  const m = en.values;
  const [result, submit, pending] = useActionState<SaveOverrideResult | null, FormData>(action, null);
  const problem = result?.status === 'invalid' ? result.problem : undefined;
  return (
    <form action={submit} className="section" aria-label={m.override}>
      <h2>{m.title}</h2>
      <p className="muted">{valueText(current)}</p>
      <label className="field">
        <span className="field__label">{m.override}</span>
        <input
          className="input"
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={amount === null ? '' : amount.toFixed(2)}
          aria-invalid={problem === undefined ? undefined : true}
          aria-describedby="override-hint"
        />
        <span className="field__hint" id="override-hint">
          {m.overrideHint(quantity, currency)}
        </span>
        {problem === undefined ? null : (
          <span className="field__error" role="alert">
            {problem === 'tooLarge' ? m.overrideProblem.tooLarge(maxAmount) : m.overrideProblem[problem]}
          </span>
        )}
      </label>
      <button type="submit" className="button" disabled={pending}>
        {pending ? m.overrideSaving : m.overrideSave}
      </button>
      {result?.status === 'saved' ? <p role="status">{result.cleared ? m.overrideCleared : m.overrideSaved}</p> : null}
      {result?.status === 'unknown-item' ? <p role="alert">{m.overrideGone}</p> : null}
    </form>
  );
}
