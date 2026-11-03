'use client';

/**
 * The values on the admin's pages (brief #207, Issue B, [VAL-3], [VAL-4], [VAL-7]), each private to
 * the admin: **Refresh prices** on `/admin`, which starts the background job through the guarded
 * `startRefresh` action (#226); the totals per segment;
 * an item's value with its source and date; and the edit form's override. The actions they call
 * are guarded (`../admin/actions.ts`).
 */
import { useActionState, useState } from 'react';
import type { ListedValue } from '../_offline/items';
import { en } from '../messages/en';
import type { CollectionTotals, SaveOverrideResult, StartPriceRefreshInput, StartPriceRefreshResult } from './value-data';

/**
 * **Refresh prices** and **Refresh every price** ([VAL-3], [VAL-9]): each press starts the
 * background job for the sets and minifigures, through the guarded `startRefresh` action, and says
 * whether it started, one was already running, or it could not start. The job runs with the page
 * closed. The progress, **Stop**, the parts scope and the outcome are #229's.
 */
export function RefreshPrices({ action }: { readonly action: (input: StartPriceRefreshInput) => Promise<StartPriceRefreshResult> }) {
  const m = en.values;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const start = (all: boolean) => {
    setProblem('');
    if (!navigator.onLine) {
      setStatus(m.needsNetwork);
      return;
    }
    setBusy(true);
    setStatus(m.refreshStarting);
    action({ scope: 'items', all }).then(
      (result) => {
        setBusy(false);
        setStatus(result.status === 'started' ? m.refreshStarted : '');
        if (result.status === 'busy') setProblem(m.refreshBusy);
        if (result.status === 'not-started') setProblem(m.refreshNotStarted);
      },
      () => {
        setBusy(false);
        setStatus('');
        setProblem(m.refreshFailed);
      },
    );
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
      {problem === '' ? null : <p role="alert">{problem}</p>}
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
