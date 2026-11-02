'use client';
/**
 * The one-screen entry form ([ITEM-9], `docs/design/ui.md`): set search or a typed set number,
 * photos, condition, completeness, instructions, quantity, description and storage location, with
 * one sticky action bar. It serves three pages:
 *
 * - `/admin/items/new`, a new item: search, falling back to a typed set number when the device is
 *   offline or search is unavailable ([CAT-5]); **Save & add next** and **Save**;
 * - `/admin/items/[id]`, an edit, online, opened with the item the server holds: **Save**, and
 *   **Delete set** at the bottom, which asks first;
 * - `/offline`, the data-free shell ([SYNC-6]): a typed set number only, never a request.
 *
 * Saving never calls the server: it queues the item's mutations in the device's queue, in
 * `[ITEM-7]`'s order (`../_offline/items.ts`), and the queue's sync replays them. **Save & add
 * next** keeps the condition and the storage location, clears the rest, shows the toast, scrolls
 * to the top and focuses the set field.
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { announceQueued, longestEdgeFor, useOnline, withDeviceQueue } from '../_offline/client';
import {
  CONDITIONS,
  draftProblems,
  ITEM_LIMITS,
  normalizeSetNumber,
  photoMoves,
  queueItem,
  queueItemDeletion,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_LENGTH,
  searchSets,
  type CatalogueSet,
  type Condition,
  type DraftField,
  type DraftPhoto,
  type DraftProblem,
  type EditableItem,
  type ItemDraft,
  type ItemOriginal,
} from '../_offline/items';
import { preparePhoto } from '../_offline/photos';
import { en } from '../messages/en';

/** Where the form returns to after a save or a deletion. */
export const ITEMS_PATH = '/admin';

/** How long the toast stays. */
export const TOAST_MS = 3000;

export type EntryFormMode = 'new' | 'edit' | 'offline';

export interface EntryFormProps {
  readonly mode: EntryFormMode;
  /** The item an edit opens with. */
  readonly item?: EditableItem;
  /** The deployment's longest photo edge; the offline shell uses the one `/admin` last passed. */
  readonly longestEdge?: number;
}

/** A photo on the form, with what its thumbnail shows. */
type FormPhoto = DraftPhoto & { readonly url: string };

type SearchState = 'idle' | 'searching' | 'ok' | 'unavailable';

const m = en.form;

/** A typed query that already looks like a set number, kept when search falls back to typing. */
function looksLikeNumber(query: string): boolean {
  return /^[A-Za-z0-9]+(-\d+)?$/.test(query.trim());
}

function SetCard({ set, chosen, onChoose, after }: { readonly set: CatalogueSet; readonly chosen?: boolean; readonly onChoose?: () => void; readonly after?: ReactNode }) {
  const body = (
    <>
      {set.imageUrl === null ? (
        <span className="set-result__image" aria-hidden="true" />
      ) : (
        // A plain img, never the image optimizer: the stock image comes straight from Rebrickable's CDN.
        <img className="set-result__image" src={set.imageUrl} alt={m.setImageAlt(set.name)} referrerPolicy="no-referrer" loading="lazy" width={64} height={64} />
      )}
      <span className="set-result__text">
        <span className="set-result__name">
          {set.setNum} {set.name}
        </span>
        <span className="muted">{m.setMeta(set)}</span>
      </span>
      {chosen === true ? (
        <span className="set-result__check" role="img" aria-label={m.search.chosen}>
          ✓
        </span>
      ) : null}
      {after}
    </>
  );
  return onChoose === undefined ? (
    <div className="set-result">{body}</div>
  ) : (
    <button type="button" className="set-result" onClick={onChoose}>
      {body}
    </button>
  );
}

function Problem({ id, problem }: { readonly id: string; readonly problem: DraftProblem | undefined }) {
  return problem === undefined ? null : (
    <p className="field__error" id={id}>
      {m.problems[problem]}
    </p>
  );
}

function YesNo({ name, label, value, onChange }: { readonly name: string; readonly label: string; readonly value: boolean; readonly onChange: (value: boolean) => void }) {
  return (
    <div className="row">
      <span id={`${name}-label`} className="field__label">
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${name}-label`}>
        {([true, false] as const).map((option) => (
          <label key={String(option)} className="choice">
            <input type="radio" name={name} value={option ? 'yes' : 'no'} checked={value === option} onChange={() => onChange(option)} />
            {option ? m.yes : m.no}
          </label>
        ))}
      </div>
    </div>
  );
}

/** An edited item's stored photos, its cover first: the form's cover is always its first photo. */
function initialPhotos(item: EditableItem | undefined): FormPhoto[] {
  const photos = item?.photos ?? [];
  const ordered = [...photos.filter((photo) => photo.cover), ...photos.filter((photo) => !photo.cover)];
  return ordered.map((photo) => ({ kind: 'stored', key: photo.id, id: photo.id, url: photo.thumbnailUrl }));
}

export function EntryForm({ mode, item, longestEdge }: EntryFormProps) {
  const online = useOnline();
  const offlineShell = mode === 'offline';
  const original: ItemOriginal | undefined =
    item === undefined ? undefined : { photoIds: item.photos.map((photo) => photo.id), coverId: item.photos.find((photo) => photo.cover)?.id ?? item.photos[0]?.id ?? null };

  const [chosen, setChosen] = useState<CatalogueSet | null>(item?.set ?? null);
  const [typing, setTyping] = useState(offlineShell);
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly CatalogueSet[]>([]);
  const [search, setSearch] = useState<SearchState>('idle');
  const [photos, setPhotos] = useState<FormPhoto[]>(() => initialPhotos(item));
  const [sheet, setSheet] = useState<string | null>(null);
  const [condition, setCondition] = useState<Condition | null>(item?.condition ?? null);
  const [complete, setComplete] = useState(item?.complete ?? true);
  const [missingNotes, setMissingNotes] = useState(item?.missingNotes ?? '');
  const [hasInstructions, setHasInstructions] = useState(item?.hasInstructions ?? true);
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [description, setDescription] = useState(item?.description ?? '');
  const [storageLocation, setStorageLocation] = useState(item?.storageLocation ?? '');
  const [problems, setProblems] = useState<Partial<Record<DraftField, DraftProblem>>>({});
  const [notice, setNotice] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** How many picked photos are still being resized: saving waits for them, so none is left behind. */
  const [preparing, setPreparing] = useState(0);
  const [focusSet, setFocusSet] = useState(0);
  const setField = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLFormElement>(null);

  // The set field is focused once it is back on the page: after Save & add next, or Change.
  useEffect(() => {
    if (focusSet > 0) setField.current?.focus();
  }, [focusSet]);

  // A new item entered without a network is typed, not searched.
  useEffect(() => {
    if (mode === 'new' && online === false) setTyping(true);
  }, [mode, online]);

  // The search: from two characters, 300 ms after the last keystroke, the last one winning.
  useEffect(() => {
    if (offlineShell || typing || chosen !== null) return;
    const trimmed = query.trim();
    if (trimmed.length < SEARCH_MIN_LENGTH) {
      setResults([]);
      setSearch('idle');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearch('searching');
      searchSets(trimmed, { signal: controller.signal }).then(
        (answer) => {
          if (answer.status === 'ok') {
            setResults(answer.sets);
            setSearch('ok');
            return;
          }
          setResults([]);
          setSearch('unavailable');
          setTyping(true);
          if (looksLikeNumber(trimmed)) setTyped(trimmed);
        },
        () => undefined,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, typing, chosen, offlineShell]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const setNum = chosen?.setNum ?? (typing ? normalizeSetNumber(typed) : '');

  function draft(id: string): ItemDraft {
    return {
      id,
      baseVersion: item?.version ?? null,
      setNum,
      condition,
      complete,
      missingNotes,
      hasInstructions,
      description,
      quantity: Number(quantity),
      storageLocation,
      photos: photos.map((photo): DraftPhoto => (photo.kind === 'new' ? { kind: 'new', key: photo.key, bytes: photo.bytes } : { kind: 'stored', key: photo.key, id: photo.id })),
    };
  }

  function forgetNewPhotos(): void {
    for (const photo of photos) if (photo.kind === 'new') URL.revokeObjectURL(photo.url);
  }

  /** Clears the form for the next set, keeping the condition and the storage location. */
  function clearForNext(): void {
    forgetNewPhotos();
    setChosen(null);
    setTyped('');
    setQuery('');
    setResults([]);
    setSearch('idle');
    setPhotos([]);
    setSheet(null);
    setComplete(true);
    setMissingNotes('');
    setHasInstructions(true);
    setQuantity('1');
    setDescription('');
    setProblems({});
    setNotice('');
  }

  async function save(then: 'next' | 'items'): Promise<void> {
    if (busy || preparing > 0) return;
    const saved = draft(item?.id ?? crypto.randomUUID());
    const found = draftProblems(saved);
    setProblems(found);
    if (Object.keys(found).length > 0) {
      setNotice(m.problemSummary);
      return;
    }
    setBusy(true);
    try {
      const queued = await withDeviceQueue((queue) => queueItem(queue, saved, original));
      if (queued === undefined) throw new Error('no queue on this device');
    } catch {
      setNotice(m.queueFailed);
      setBusy(false);
      return;
    }
    announceQueued();
    if (then === 'items') {
      window.location.assign(ITEMS_PATH);
      return;
    }
    clearForNext();
    setBusy(false);
    setToast(m.toast(saved.setNum, saved.photos.length));
    top.current?.scrollIntoView?.({ block: 'start' });
    setFocusSet((count) => count + 1);
  }

  async function remove(): Promise<void> {
    if (item === undefined || busy || !window.confirm(m.confirmDelete)) return;
    setBusy(true);
    try {
      const queued = await withDeviceQueue((queue) => queueItemDeletion(queue, item.id));
      if (queued === undefined) throw new Error('no queue on this device');
    } catch {
      setNotice(m.queueFailed);
      setBusy(false);
      return;
    }
    announceQueued();
    window.location.assign(ITEMS_PATH);
  }

  const addPhotos = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    setPreparing((count) => count + files.length);
    void (async () => {
      const edge = longestEdgeFor(offlineShell ? undefined : longestEdge);
      for (const file of files) {
        try {
          const bytes = await preparePhoto(file, edge);
          const photo: FormPhoto = { kind: 'new', key: crypto.randomUUID(), bytes, url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) };
          // Each photo joins the strip as soon as it is ready, not after the slowest of the batch.
          setPhotos((before) => [...before, photo]);
        } catch {
          setNotice(m.photos.unreadable);
        } finally {
          setPreparing((count) => count - 1);
        }
      }
    })();
  };

  /** Moves a photo to another place; to place 0 makes it the cover. */
  const movePhoto = (key: string, to: (from: number) => number) => {
    setPhotos((before) => {
      const from = before.findIndex((photo) => photo.key === key);
      const target = to(from);
      if (from === -1 || target < 0 || target >= before.length) return before;
      const next = [...before];
      const [moved] = next.splice(from, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    });
  };

  const removePhoto = (key: string) => {
    const gone = photos.find((photo) => photo.key === key);
    if (gone?.kind === 'new') URL.revokeObjectURL(gone.url);
    // Removing the cover makes the next photo the cover ([ITEM-6]).
    setPhotos(photos.filter((photo) => photo.key !== key));
    setSheet(null);
  };

  const cover = photos[0]?.key ?? null;
  const sheetIndex = photos.findIndex((photo) => photo.key === sheet);
  const moves = photoMoves(photos, sheetIndex);
  const title = mode === 'edit' ? m.editTitle : offlineShell ? m.offlineTitle : m.addTitle;

  return (
    <form
      ref={top}
      className="section"
      aria-label={title}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save(mode === 'edit' ? 'items' : 'next');
      }}
    >
      {mode === 'edit' && online === false ? <p className="card">{m.editOffline}</p> : null}
      {notice === '' ? null : (
        <p className="field__error" role="alert">
          {notice}
        </p>
      )}

      <section className="section" aria-label={m.search.label}>
        {chosen !== null ? (
          <SetCard
            set={chosen}
            chosen
            after={
              <button
                type="button"
                className="button button--link"
                onClick={() => {
                  setChosen(null);
                  setFocusSet((count) => count + 1);
                }}
              >
                {m.search.change}
              </button>
            }
          />
        ) : typing ? (
          <label className="field">
            <span className="field__label">{m.search.typedLabel}</span>
            <input
              ref={setField}
              className="input"
              name="setNum"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              placeholder={m.search.typedPlaceholder}
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
              aria-invalid={problems.setNum !== undefined}
              aria-describedby="setNum-hint setNum-problem"
            />
            <span className="field__hint" id="setNum-hint">
              {search === 'unavailable' ? `${m.search.unavailable} ` : ''}
              {m.search.typedHint}
            </span>
            <Problem id="setNum-problem" problem={problems.setNum} />
            {offlineShell || online === false ? null : (
              <button
                type="button"
                className="button button--link"
                onClick={() => {
                  setTyping(false);
                  setSearch('idle');
                }}
              >
                {m.search.useSearch}
              </button>
            )}
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field__label">{m.search.label}</span>
              <input
                ref={setField}
                className="input"
                type="search"
                name="setSearch"
                autoComplete="off"
                placeholder={m.search.placeholder}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                aria-invalid={problems.setNum !== undefined}
                aria-describedby="setNum-problem"
              />
              <Problem id="setNum-problem" problem={problems.setNum} />
            </label>
            {search === 'searching' ? <p className="muted">{m.search.searching}</p> : null}
            {search === 'ok' && results.length === 0 ? <p className="muted">{m.search.noResults}</p> : null}
            {results.length === 0 ? null : (
              <ul className="results" aria-label={m.search.resultsLabel}>
                {results.map((set) => (
                  <li key={set.setNum}>
                    <SetCard
                      set={set}
                      onChoose={() => {
                        setChosen(set);
                        setResults([]);
                        setSearch('idle');
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="button button--link" onClick={() => setTyping(true)}>
              {m.search.useTyped}
            </button>
          </>
        )}
      </section>

      <section className="section" aria-label={m.photos.label}>
        <h2>{m.photos.label}</h2>
        <ul className="photo-strip">
          <li>
            <label className="photo-tile photo-add">
              <span aria-hidden="true">📷</span>
              {m.photos.add}
              <input type="file" accept="image/*" multiple onChange={addPhotos} />
            </label>
          </li>
          {photos.map((photo, index) => (
            <li key={photo.key}>
              <button type="button" className="photo-tile" aria-label={m.photos.photoLabel(index + 1, photo.key === cover)} onClick={() => setSheet(photo.key)}>
                <img src={photo.url} alt="" referrerPolicy="no-referrer" />
                {photo.key === cover ? (
                  <span className="photo-tile__cover" aria-hidden="true">
                    {m.photos.cover}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {Array.from({ length: preparing }, (_, index) => (
            <li key={`preparing-${index}`}>
              <span className="photo-tile photo-tile--preparing" role="status" aria-label={m.photos.preparingLabel}>
                {m.photos.preparing}
              </span>
            </li>
          ))}
        </ul>
        {sheet === null || sheetIndex === -1 ? null : (
          <div className="sheet" role="dialog" aria-label={m.photos.sheetLabel}>
            <button
              type="button"
              className="button"
              disabled={!moves.cover}
              onClick={() => {
                movePhoto(sheet, () => 0);
                setSheet(null);
              }}
            >
              {m.photos.makeCover}
            </button>
            <button type="button" className="button" disabled={!moves.left} onClick={() => movePhoto(sheet, (from) => from - 1)}>
              {m.photos.moveLeft}
            </button>
            <button type="button" className="button" disabled={!moves.right} onClick={() => movePhoto(sheet, (from) => from + 1)}>
              {m.photos.moveRight}
            </button>
            <button type="button" className="button button--danger" onClick={() => removePhoto(sheet)}>
              {m.photos.remove}
            </button>
            <button type="button" className="button button--link" onClick={() => setSheet(null)}>
              {m.photos.close}
            </button>
          </div>
        )}
      </section>

      <section className="section card" aria-label={m.conditionLabel}>
        <fieldset className="choices" aria-describedby="condition-problem">
          <legend>{m.conditionLabel}</legend>
          {CONDITIONS.map((option) => (
            <label key={option} className="choice">
              <input type="radio" name="condition" value={option} checked={condition === option} onChange={() => setCondition(option)} />
              {en.condition[option]}
            </label>
          ))}
        </fieldset>
        <Problem id="condition-problem" problem={problems.condition} />

        <YesNo name="complete" label={m.complete} value={complete} onChange={setComplete} />
        {complete ? null : (
          <label className="field">
            <span className="field__label">{m.missing}</span>
            <input className="input" name="missingNotes" maxLength={ITEM_LIMITS.missingNotes} value={missingNotes} onChange={(event) => setMissingNotes(event.currentTarget.value)} />
            <Problem id="missingNotes-problem" problem={problems.missingNotes} />
          </label>
        )}
        <YesNo name="hasInstructions" label={m.instructions} value={hasInstructions} onChange={setHasInstructions} />

        <div className="row">
          <span id="quantity-label" className="field__label">
            {m.quantity}
          </span>
          <span className="stepper" role="group" aria-labelledby="quantity-label">
            <button type="button" className="button" aria-label={m.decrease} onClick={() => setQuantity((q) => String(Math.max(ITEM_LIMITS.quantityMin, (Number(q) || 1) - 1)))}>
              −
            </button>
            <input
              name="quantity"
              inputMode="numeric"
              pattern="[0-9]*"
              aria-labelledby="quantity-label"
              aria-invalid={problems.quantity !== undefined}
              value={quantity}
              onChange={(event) => setQuantity(event.currentTarget.value.replace(/[^0-9]/g, ''))}
            />
            <button type="button" className="button" aria-label={m.increase} onClick={() => setQuantity((q) => String(Math.min(ITEM_LIMITS.quantityMax, (Number(q) || 0) + 1)))}>
              +
            </button>
          </span>
        </div>
        <Problem id="quantity-problem" problem={problems.quantity} />

        <label className="field">
          <span className="field__label">{m.description}</span>
          <textarea className="input" name="description" maxLength={ITEM_LIMITS.description} value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
          <Problem id="description-problem" problem={problems.description} />
        </label>

        <label className="field">
          <span className="field__label">
            {m.storage} <span aria-hidden="true">{m.storageIcon}</span>
          </span>
          <input
            className="input"
            name="storageLocation"
            maxLength={ITEM_LIMITS.storageLocation}
            value={storageLocation}
            onChange={(event) => setStorageLocation(event.currentTarget.value)}
            aria-describedby="storage-hint"
          />
          <span className="field__hint" id="storage-hint">
            {m.storageHint}
          </span>
          <Problem id="storageLocation-problem" problem={problems.storageLocation} />
        </label>
      </section>

      {mode === 'edit' ? (
        <button type="button" className="button button--danger" disabled={busy} onClick={() => void remove()}>
          {m.delete}
        </button>
      ) : null}

      {toast === null ? null : (
        <p className="toast" role="status">
          {toast}
        </p>
      )}

      <div className="action-bar">
        {mode === 'edit' ? (
          <button type="submit" className="button button--primary button--wide" disabled={busy || preparing > 0}>
            {preparing > 0 ? m.preparingPhotos : busy ? m.saving : m.save}
          </button>
        ) : (
          <>
            <button type="submit" className="button button--primary button--wide" disabled={busy || preparing > 0}>
              {preparing > 0 ? m.preparingPhotos : m.saveAndNext}
            </button>
            {offlineShell ? null : (
              <button type="button" className="button" disabled={busy || preparing > 0} onClick={() => void save('items')}>
                {m.save}
              </button>
            )}
          </>
        )}
      </div>
    </form>
  );
}
