'use client';

/**
 * The parts file's import on `/admin/parts` ([PARTS-2] to [PARTS-4]). Choosing a file asks first,
 * when an inventory is there, whether to replace it; then it asks the presign route for an upload
 * into the private `imports/` prefix, posts the file straight to S3, and calls the guarded
 * `importParts` action, which reads, parses and deletes it. The import needs the network: the
 * server parses the file, so nothing is queued on the device.
 */
import { useState, type ChangeEvent } from 'react';
import type { ImportPartsResult } from '../../server/parts/parts';
import { en } from '../messages/en';

/** The presign route (`src/app/admin/api/parts/uploads/route.ts`). */
export const PARTS_PRESIGN_ENDPOINT = '/admin/api/parts/uploads';

/** How long the presign or the upload may take. */
export const PARTS_UPLOAD_TIMEOUT_MS = 120_000;

type Outcome = { readonly kind: 'status' | 'alert'; readonly text: string; readonly skipped?: readonly number[] };

interface Presigned {
  readonly key?: unknown;
  readonly url?: unknown;
  readonly fields?: unknown;
  readonly maxBytes?: unknown;
}

export interface PartsUploadDependencies {
  readonly fetch: typeof fetch;
  readonly online: () => boolean;
  readonly confirm: (message: string) => boolean;
  readonly importParts: (uploadKey: string) => Promise<ImportPartsResult>;
}

/** Uploads and imports one file, answering what to tell the owner. Exported for the tests. */
export async function uploadAndImport(file: Blob, currentLots: number | null, dependencies: PartsUploadDependencies, progress: (text: string) => void = () => undefined): Promise<Outcome> {
  const m = en.parts;
  if (!dependencies.online()) return { kind: 'alert', text: m.needsNetwork };
  if (currentLots !== null && !dependencies.confirm(m.confirmReplace(currentLots))) return { kind: 'status', text: '' };

  progress(m.uploading);
  let presigned: Presigned;
  try {
    const response = await dependencies.fetch(PARTS_PRESIGN_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(PARTS_UPLOAD_TIMEOUT_MS),
    });
    if (response.status === 401) return { kind: 'alert', text: m.signedOut };
    if (!response.ok) return { kind: 'alert', text: m.failed };
    presigned = (await response.json()) as Presigned;
  } catch {
    return { kind: 'alert', text: m.needsNetwork };
  }
  const { key, url, fields, maxBytes } = presigned;
  if (typeof key !== 'string' || typeof url !== 'string' || typeof fields !== 'object' || fields === null) return { kind: 'alert', text: m.failed };
  if (typeof maxBytes === 'number' && file.size > maxBytes) return { kind: 'alert', text: m.tooLarge(maxBytes) };

  // The policy's fields first, the file last, as S3 requires of a POST.
  const form = new FormData();
  for (const [name, value] of Object.entries(fields as Record<string, unknown>)) form.append(name, String(value));
  form.append('file', file);
  try {
    const response = await dependencies.fetch(url, { method: 'POST', body: form, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(PARTS_UPLOAD_TIMEOUT_MS) });
    if (!response.ok) return { kind: 'alert', text: response.status === 400 && typeof maxBytes === 'number' ? m.tooLarge(maxBytes) : m.failed };
  } catch {
    return { kind: 'alert', text: m.needsNetwork };
  }

  progress(m.importing);
  let result: ImportPartsResult;
  try {
    result = await dependencies.importParts(key);
  } catch {
    return { kind: 'alert', text: m.failed };
  }
  if (result.status === 'imported') {
    const skipped = result.skipped.length === 0 ? '' : ` ${m.skipped(result.skipped)}`;
    const text = `${m.imported(result.lots, result.quantity)}${skipped}`;
    return result.skipped.length === 0 ? { kind: 'status', text } : { kind: 'status', text, skipped: result.skipped };
  }
  if (result.code === 'too-large' && typeof maxBytes === 'number') return { kind: 'alert', text: m.tooLarge(maxBytes) };
  return { kind: 'alert', text: m.refused(result.reason, result.lot) };
}

/** The parts page, which the import reloads into. */
const PARTS_PATH = '/admin/parts';

/** The most skipped lots' places a notice names; the count says how many there were in all. */
export const SKIPPED_PLACES_SHOWN = 10;

/**
 * The query that carries an import's skipped lots across the page's reload ([PARTS-1]), so the
 * notice survives the summary's refresh: the count, and at most `SKIPPED_PLACES_SHOWN` places.
 * Nothing but numbers: never a lot's fields or remarks.
 */
export function skippedQuery(skipped: readonly number[]): string {
  if (skipped.length === 0) return '';
  return `?skipped=${skipped.length}&at=${skipped.slice(0, SKIPPED_PLACES_SHOWN).join(',')}`;
}

/**
 * Where the page goes after an import that succeeded ([PARTS-1]): `/admin/parts`, carrying a
 * skipped-lots notice if and only if *this* import skipped lots. An earlier import's notice is
 * always dropped; any other notice in `currentSearch` (such as `catalogue=stale`, which an import
 * doesn't resolve) is kept.
 */
export function nextPartsUrl(skipped: readonly number[], currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete('skipped');
  params.delete('at');
  if (skipped.length > 0) {
    params.set('skipped', String(skipped.length));
    params.set('at', skipped.slice(0, SKIPPED_PLACES_SHOWN).join(','));
  }
  const query = params.toString();
  return query === '' ? PARTS_PATH : `${PARTS_PATH}?${query.replaceAll('%2C', ',')}`;
}

/** Reads `skippedQuery`'s parameters back, or null when they're absent or not what it writes. */
export function parseSkipped(params: Record<string, string | string[] | undefined> | undefined): { count: number; places: number[] } | null {
  const count = params?.skipped;
  const at = params?.at;
  if (typeof count !== 'string' || typeof at !== 'string' || !/^\d{1,6}$/.test(count) || !/^\d{1,6}(,\d{1,6}){0,9}$/.test(at)) return null;
  const places = at.split(',').map(Number);
  const total = Number(count);
  if (total < places.length || total === 0) return null;
  return { count: total, places };
}

export function PartsImport({
  currentLots,
  importParts,
}: {
  /** The current inventory's lots, or null when nothing is imported yet: a replace asks first. */
  readonly currentLots: number | null;
  readonly importParts: (uploadKey: string) => Promise<ImportPartsResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'status', text: '' });
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    setBusy(true);
    void uploadAndImport(
      file,
      currentLots,
      { fetch: globalThis.fetch.bind(globalThis), online: () => navigator.onLine, confirm: (message) => window.confirm(message), importParts },
      (text) => setOutcome({ kind: 'status', text }),
    ).then((result) => {
      const skipped = result.skipped ?? [];
      setOutcome(result);
      setBusy(false);
      // A new inventory: the page reads its summary again, and keeps the skipped lots' notice.
      if (result.kind === 'status' && result.text !== '') window.location.assign(nextPartsUrl(skipped, window.location.search));
    });
  };
  return (
    <section className="section" aria-label={en.parts.importLabel}>
      <h2>{en.parts.importLabel}</h2>
      {currentLots === null ? null : <p className="muted">{en.parts.replaceWarning}</p>}
      <label className="button" aria-disabled={busy}>
        {en.parts.choose}{' '}
        <input className="visually-hidden" type="file" accept=".bsx,.xml,application/xml,text/xml" disabled={busy} onChange={onChange} />
      </label>
      {outcome.text === '' ? null : <p role={outcome.kind}>{outcome.text}</p>}
    </section>
  );
}
