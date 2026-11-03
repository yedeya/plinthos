'use client';

/**
 * The values on the admin's pages (brief #207, Issue B, [VAL-3], [VAL-4], [VAL-7]; #229, [VAL-11]),
 * each private to the admin: **Refresh prices** on `/admin`, which starts the background job
 * through the guarded `startRefresh` action and follows it through `refreshStatus` and
 * `stopRefresh`; the totals per segment; an item's value with its source and date; and the edit
 * form's override. The actions they call are guarded (`../admin/actions.ts`).
 */
import { useActionState, useEffect, useState } from 'react';
import type { ListedValue } from '../_offline/items';
import { en } from '../messages/en';
import type {
  CollectionTotals,
  PriceRefreshRunView,
  PriceRefreshStatus,
  SaveOverrideResult,
  StartPriceRefreshInput,
  StartPriceRefreshResult,
  StopPriceRefreshResult,
} from './value-data';

/** How often `/admin` asks for a running refresh's progress ([VAL-11]). */
export const REFRESH_POLL_MS = 3_000;

const SCOPES = ['items', 'parts', 'all'] as const;

/** What the last run came to, once it ended ([VAL-4], [VAL-9], [VAL-10], [VAL-11]). */
export function outcomeText(run: PriceRefreshRunView): string {
  const m = en.values;
  if (run.state === 'done') return m.outcome.done;
  return m.outcome[run.stopReason ?? 'owner'];
}

/**
 * **Refresh prices** ([VAL-3], [VAL-9] to [VAL-11]): the scope (sets and minifigures, parts, or
 * everything) and **Every price**, which start the background job through the guarded
 * `startRefresh` action; the job runs with the page closed. While a run runs, its progress (done,
 * failed and left), asked for through `refreshStatus` every `pollMs` only while the page is
 * visible and the run is running, and **Stop**. Once it ends, its outcome: done, stopped by the
 * owner, stopped with a reason, the daily limit (pressing again after midnight UTC carries on) or
 * stalled. And the BrickLink calls used today against the limit.
 */
export function RefreshPrices({
  start,
  stop,
  status,
  initial,
  pollMs = REFRESH_POLL_MS,
}: {
  readonly start: (input: StartPriceRefreshInput) => Promise<StartPriceRefreshResult>;
  readonly stop: () => Promise<StopPriceRefreshResult>;
  readonly status: () => Promise<PriceRefreshStatus>;
  /** The refresh as the page was rendered. */
  readonly initial: PriceRefreshStatus;
  readonly pollMs?: number;
}) {
  const m = en.values;
  const [current, setCurrent] = useState<PriceRefreshStatus>(initial);
  const [scope, setScope] = useState<StartPriceRefreshInput['scope']>('items');
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');
  const run = current.run;
  const running = run?.state === 'running';
  const withRun = (next: PriceRefreshRunView | null) => setCurrent((previous) => ({ ...previous, run: next }));

  // Polls while the run runs and the page is visible; a hidden page asks for nothing.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState === 'visible';
    const schedule = () => {
      if (!cancelled && timer === undefined && visible()) timer = setTimeout(tick, pollMs);
    };
    const tick = () => {
      timer = undefined;
      if (cancelled || !visible()) return;
      status().then(
        (next) => {
          if (cancelled) return;
          // An answer clears only its own failure, never what a press said.
          setProblem((previous) => (previous === m.statusFailed ? '' : previous));
          setCurrent(next);
          schedule();
        },
        () => {
          if (cancelled) return;
          setProblem(m.statusFailed);
          schedule();
        },
      );
    };
    const onVisibility = () => {
      if (visible()) schedule();
      else if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [running, status, pollMs, m.statusFailed]);

  const refresh = () => {
    setProblem('');
    if (!navigator.onLine) {
      setNotice(m.needsNetwork);
      return;
    }
    setBusy(true);
    setNotice(m.refreshStarting);
    start({ scope, all }).then(
      (result) => {
        setBusy(false);
        setNotice(result.status === 'started' ? m.refreshStarted : '');
        if (result.run !== null) withRun(result.run);
        if (result.status === 'busy') setProblem(m.refreshBusy);
        if (result.status === 'not-started') setProblem(m.refreshNotStarted);
      },
      () => {
        setBusy(false);
        setNotice('');
        setProblem(m.refreshFailed);
      },
    );
  };

  const askStop = () => {
    setProblem('');
    setBusy(true);
    stop().then(
      (result) => {
        setBusy(false);
        setNotice('');
        if (result.run !== null) withRun(result.run);
        else status().then(setCurrent, () => setProblem(m.statusFailed));
      },
      () => {
        setBusy(false);
        setProblem(m.stopFailed);
      },
    );
  };

  return (
    <section className="section" aria-label={m.refreshLabel}>
      <p className="muted">{m.refreshHint}</p>
      <fieldset className="choices">
        <legend>{m.scopeLabel}</legend>
        {SCOPES.map((option) => (
          <label key={option} className="choice">
            <input type="radio" name="refreshScope" value={option} checked={scope === option} onChange={() => setScope(option)} disabled={busy || running} />
            {m.scope[option]}
          </label>
        ))}
      </fieldset>
      <div className="footer__actions">
        <label className="choice">
          <input type="checkbox" name="refreshAll" checked={all} onChange={(event) => setAll(event.target.checked)} disabled={busy || running} /> {m.refreshAll}
        </label>
        <button type="button" className="button" disabled={busy || running} onClick={refresh}>
          {m.refresh}
        </button>
      </div>
      {run === null ? null : running ? (
        <div className="card" aria-label={m.progressLabel} aria-live="polite">
          <p>
            {m.running} {m.runScope(run.scope, run.all)}
          </p>
          <progress className="progress" max={Math.max(1, run.done + run.failed + run.left)} value={run.done + run.failed} />
          <p>{m.progress(run.done, run.failed, run.left)}</p>
          {run.stopRequested ? (
            <p className="muted">{m.stopping}</p>
          ) : (
            <button type="button" className="button button--danger" disabled={busy} onClick={askStop}>
              {m.stop}
            </button>
          )}
        </div>
      ) : (
        <div className="card" aria-label={m.progressLabel}>
          <p className="muted">
            {m.lastRun(run.finishedAt ?? run.heartbeatAt)} {m.runScope(run.scope, run.all)}
          </p>
          <p>{m.progress(run.done, run.failed, run.left)}</p>
          <p data-outcome={run.state === 'done' ? 'done' : (run.stopReason ?? 'owner')}>{outcomeText(run)}</p>
        </div>
      )}
      <p className="muted">{m.callsToday(current.callsToday, current.dailyLimit)}</p>
      {notice === '' ? null : <p role="status">{notice}</p>}
      {problem === '' ? null : <p role="alert">{problem}</p>}
    </section>
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
