'use client';

/**
 * The two forms on `/admin/settings` ([PUB-9], [PUB-15]): the catalogue's intro and contact
 * texts with Save, and Rotate catalogue link behind a confirmation that says the old link stops
 * working. They live outside `src/app/admin/` because they are components, not routes; the
 * actions they call are guarded (`../admin/actions.ts`).
 */
import { useActionState } from 'react';
import type { CatalogueTextField, RotateResult, SaveTextsResult } from './settings-data';
import type { AdjustmentField, SaveAdjustmentsResult } from './value-data';
import { en } from '../messages/en';

export function CatalogueTextsForm({
  action,
  introText,
  contactText,
  maxText,
}: {
  readonly action: (previous: SaveTextsResult | null, form: FormData) => Promise<SaveTextsResult>;
  readonly introText: string;
  readonly contactText: string;
  /** The longest text, in characters: the schema's one limit, passed from the server. */
  readonly maxText: number;
}) {
  const m = en.settings;
  const [result, submit, pending] = useActionState<SaveTextsResult | null, FormData>(action, null);
  const problem = (field: CatalogueTextField) => (result?.status === 'invalid' ? result.problems[field] : undefined);
  const field = (name: CatalogueTextField, label: string, hint: string, value: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <textarea
        className="input"
        name={name}
        rows={5}
        maxLength={maxText}
        defaultValue={value}
        aria-invalid={problem(name) === undefined ? undefined : true}
        aria-describedby={`${name}-hint`}
      />
      <span className="field__hint" id={`${name}-hint`}>
        {hint} {m.limit(maxText)}
      </span>
      {problem(name) === undefined ? null : (
        <span className="field__error" role="alert">
          {problem(name) === 'tooLong' ? m.tooLong(maxText) : m.notPlain}
        </span>
      )}
    </label>
  );
  return (
    <form action={submit} className="section" aria-label={m.texts}>
      <h2>{m.texts}</h2>
      <p className="muted">{m.textsHint}</p>
      {field('introText', m.intro, m.introHint, introText)}
      {field('contactText', m.contact, m.contactHint, contactText)}
      <button type="submit" className="button button--primary" disabled={pending}>
        {pending ? m.saving : m.save}
      </button>
      {result?.status === 'saved' ? <p role="status">{m.saved}</p> : null}
    </form>
  );
}

export function RotateLinkForm({ action, url }: { readonly action: () => Promise<RotateResult>; readonly url: string | null }) {
  const m = en.settings;
  const [result, submit, pending] = useActionState<RotateResult | null>(() => action(), null);
  const current = result?.status === 'rotated' ? result.url : url;
  return (
    <form
      action={submit}
      className="section"
      aria-label={m.link}
      onSubmit={(event) => {
        if (!window.confirm(m.confirmRotate)) event.preventDefault();
      }}
    >
      <h2>{m.link}</h2>
      {current === null ? (
        <p className="muted">{m.noLink}</p>
      ) : (
        <>
          <p className="settings__link">
            <a href={current} rel="noreferrer">
              {current}
            </a>
          </p>
          <p className="muted">{m.linkHint}</p>
        </>
      )}
      <p className="muted">{m.rotateHint}</p>
      <button type="submit" className="button button--danger" disabled={pending || current === null}>
        {pending ? m.rotating : m.rotate}
      </button>
      <RotateOutcome result={result} />
    </form>
  );
}

export function RotateOutcome({ result }: { readonly result: RotateResult | null }) {
  const m = en.settings;
  if (result === null) return null;
  if (result.status === 'rotated') {
    if (result.oldRemoved) return <p role="status">{m.rotated}</p>;
    // [PUB-15]: the new link works, but the old one may still serve until it is cleaned up.
    return (
      <p role="alert">
        {m.rotated} {m.oldNotRemoved}
      </p>
    );
  }
  return (
    <p role="alert">
      {m.rotateFailed} {result.busy === true ? `${m.rotateBusy} ` : ''}
      {result.previousKept ? m.rotateKept : m.rotatePartial} {m.reference(result.requestId)}
    </p>
  );
}

/** The per-condition value adjustments ([VAL-5], [VAL-7]): two whole percentages, private to the admin. */
export function ValueAdjustmentsForm({
  action,
  usedWithBoxPct,
  usedNoBoxPct,
  range,
}: {
  readonly action: (previous: SaveAdjustmentsResult | null, form: FormData) => Promise<SaveAdjustmentsResult>;
  readonly usedWithBoxPct: number;
  readonly usedNoBoxPct: number;
  readonly range: { readonly min: number; readonly max: number };
}) {
  const m = en.values;
  const [result, submit, pending] = useActionState<SaveAdjustmentsResult | null, FormData>(action, null);
  const field = (name: AdjustmentField, label: string, value: number) => {
    const refused = result?.status === 'invalid' && result.problems[name] !== undefined;
    return (
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          className="input"
          name={name}
          type="number"
          inputMode="numeric"
          step={1}
          min={range.min}
          max={range.max}
          defaultValue={value}
          aria-invalid={refused ? true : undefined}
          aria-describedby={`${name}-hint`}
        />
        <span className="field__hint" id={`${name}-hint`}>
          {m.adjustRange(range.min, range.max)}
        </span>
        {refused ? (
          <span className="field__error" role="alert">
            {m.adjustRange(range.min, range.max)}
          </span>
        ) : null}
      </label>
    );
  };
  return (
    <form action={submit} className="section" aria-label={m.adjustments}>
      <h2>{m.adjustments}</h2>
      <p className="muted">{m.adjustmentsHint}</p>
      {field('usedWithBoxPct', m.adjustUsedWithBox, usedWithBoxPct)}
      {field('usedNoBoxPct', m.adjustUsedNoBox, usedNoBoxPct)}
      <button type="submit" className="button button--primary" disabled={pending}>
        {pending ? m.adjustSaving : m.adjustSave}
      </button>
      {result?.status === 'saved' ? <p role="status">{m.adjustSaved}</p> : null}
    </form>
  );
}
