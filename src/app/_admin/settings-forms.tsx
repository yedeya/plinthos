'use client';

/**
 * The two forms on `/admin/settings` ([PUB-9], [PUB-15]): the catalogue's intro and contact
 * texts with Save, and Rotate catalogue link behind a confirmation that says the old link stops
 * working. They live outside `src/app/admin/` because they are components, not routes; the
 * actions they call are guarded (`../admin/actions.ts`).
 */
import { useActionState } from 'react';
import type { RotateResult, SaveTextsResult } from './settings-data';
import { en } from '../messages/en';

/** The longest text, in characters: the service function's limit ([PUB-9]). */
const MAX = 2000;

export function CatalogueTextsForm({
  action,
  introText,
  contactText,
}: {
  readonly action: (previous: SaveTextsResult | null, form: FormData) => Promise<SaveTextsResult>;
  readonly introText: string;
  readonly contactText: string;
}) {
  const m = en.settings;
  const [result, submit, pending] = useActionState<SaveTextsResult | null, FormData>(action, null);
  const invalid = (field: 'introText' | 'contactText') => result?.status === 'invalid' && result.fields.includes(field);
  const field = (name: 'introText' | 'contactText', label: string, hint: string, value: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <textarea
        className="input"
        name={name}
        rows={5}
        maxLength={MAX}
        defaultValue={value}
        aria-invalid={invalid(name) ? true : undefined}
        aria-describedby={`${name}-hint`}
      />
      <span className="field__hint" id={`${name}-hint`}>
        {hint} {m.limit(MAX)}
      </span>
      {invalid(name) ? (
        <span className="field__error" role="alert">
          {m.tooLong(MAX)}
        </span>
      ) : null}
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
  if (result.status === 'rotated') return <p role="status">{m.rotated}</p>;
  return (
    <p role="alert">
      {m.rotateFailed} {result.previousKept ? m.rotateKept : m.rotatePartial} {m.reference(result.requestId)}
    </p>
  );
}
