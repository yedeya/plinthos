'use client';
/**
 * The one-screen entry form ([ITEM-9], `docs/design/ui.md`): one set field, "Set number or name",
 * then photos, condition, completeness, instructions, quantity, description and storage location,
 * with one sticky action bar. The set field searches as the owner types, about a second after the
 * last digit of a set number and half a second after the last letter of a name, each newer text
 * aborting the search before it; and text that reads as a set number saves as one without a pick,
 * the matching result's set when the results hold it, otherwise resolved when it syncs
 * ([ITEM-4]). It serves three pages:
 *
 * - `/admin/items/new`, a new item: **Save & add next** and **Save**;
 * - `/admin/items/[id]`, an edit, online, opened with the item the server holds: **Save**, and
 *   **Delete set** at the top, which asks first;
 * - `/offline`, the data-free shell ([SYNC-6]): the same field, which never sends a request, as
 *   on a device without a network or while search isn't answering ([CAT-5]).
 *
 * Not every item is a set (#202): with no set chosen and text that isn't a set number, the form
 * offers to log it as a minifigure, a bulk lot or another item, and **Not a set?** beside the field
 * always does. Such an item has a kind, a name (prefilled from the typed text), an optional
 * reference number and, for a bulk lot, an approximate piece count and weight; its completeness
 * and instructions may stay unstated. Nothing about it needs the network, so the offline shell
 * logs it the same way.
 *
 * Saving never calls the server: it queues the item's mutations in the device's queue, in
 * `[ITEM-7]`'s order (`../_offline/items.ts`), and the queue's sync replays them. **Save & add
 * next** keeps the kind, the condition and the storage location, clears the rest, shows the toast,
 * scrolls to the top and focuses the set field, or the name field for a non-set.
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { announceQueued, longestEdgeFor, nextSync, SAVE_SYNC_WAIT_MS, useOnline, withDeviceQueue } from '../_offline/client';
import {
  CONDITIONS,
  draftProblems,
  ITEM_LIMITS,
  OTHER_KINDS,
  normalizeSetNumber,
  photoMoves,
  queueItem,
  queueItemDeletion,
  looksLikeSetNumber,
  searchDelayMs,
  SEARCH_MIN_LENGTH,
  searchSets,
  type CatalogueSet,
  type Condition,
  type DraftField,
  type DraftPhoto,
  type DraftProblem,
  type EditableItem,
  type ItemDraft,
  type ItemKind,
  type ItemOriginal,
  type OtherKind,
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

type SearchState = 'idle' | 'searching' | 'ok' | 'partial' | 'unavailable';

const m = en.form;

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

/** Yes or no; for a non-set also **Not stated**, null, since its completeness and instructions are optional (#202). */
function YesNo({
  name,
  label,
  value,
  onChange,
  unset = false,
}: {
  readonly name: string;
  readonly label: string;
  readonly value: boolean | null;
  readonly onChange: (value: boolean | null) => void;
  readonly unset?: boolean;
}) {
  const options: readonly (boolean | null)[] = unset ? [true, false, null] : [true, false];
  return (
    <div className="row">
      <span id={`${name}-label`} className="field__label">
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${name}-label`}>
        {options.map((option) => (
          <label key={String(option)} className="choice">
            <input type="radio" name={name} value={option === null ? 'unstated' : option ? 'yes' : 'no'} checked={value === option} onChange={() => onChange(option)} />
            {option === null ? m.notStated : option ? m.yes : m.no}
          </label>
        ))}
      </div>
    </div>
  );
}

/** What completeness and instructions start as: yes for a set, not stated for any other kind (#202). */
function defaultYesNo(kind: ItemKind): boolean | null {
  return kind === 'SET' ? true : null;
}

/** A bulk lot's number field's text: digits only, empty when not given. */
function numberText(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** An edited item's stored photos, its cover first: the form's cover is always its first photo. */
function initialPhotos(item: EditableItem | undefined): FormPhoto[] {
  const photos = item?.photos ?? [];
  const ordered = [...photos.filter((photo) => photo.cover), ...photos.filter((photo) => !photo.cover)];
  return ordered.map((photo) => ({
    kind: 'stored',
    key: photo.id,
    id: photo.id,
    url: photo.thumbnailUrl,
  }));
}

export function EntryForm({ mode, item, longestEdge }: EntryFormProps) {
  const online = useOnline();
  const offlineShell = mode === 'offline';
  const original: ItemOriginal | undefined =
    item === undefined
      ? undefined
      : {
          photoIds: item.photos.map((photo) => photo.id),
          coverId: item.photos.find((photo) => photo.cover)?.id ?? item.photos[0]?.id ?? null,
        };

  const [kind, setKind] = useState<ItemKind>(item?.kind ?? 'SET');
  const [name, setName] = useState(item?.name ?? '');
  const [refNo, setRefNo] = useState(item?.refNo ?? '');
  const [approxParts, setApproxParts] = useState(numberText(item?.approxParts));
  const [approxWeightG, setApproxWeightG] = useState(numberText(item?.approxWeightG));
  /** The non-set kind **Not a set?** picks: the last one the owner chose. */
  const lastOther = useRef<OtherKind>(item === undefined || item.kind === 'SET' ? 'MINIFIG' : item.kind);
  const [chosen, setChosen] = useState<CatalogueSet | null>(item?.set ?? null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly CatalogueSet[]>([]);
  /** The trimmed text the shown results answer, or null when none do. */
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>('idle');
  const [photos, setPhotos] = useState<FormPhoto[]>(() => initialPhotos(item));
  const [sheet, setSheet] = useState<string | null>(null);
  const [condition, setCondition] = useState<Condition | null>(item?.condition ?? null);
  const [complete, setComplete] = useState<boolean | null>(item === undefined ? true : item.complete);
  const [missingNotes, setMissingNotes] = useState(item?.missingNotes ?? '');
  const [hasInstructions, setHasInstructions] = useState<boolean | null>(item === undefined ? true : item.hasInstructions);
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
  /** What Save & add next kept when it last cleared the form, or null before the first save. */
  const clearedWith = useRef<{
    readonly kind: ItemKind;
    readonly condition: typeof condition;
    readonly storageLocation: string;
  } | null>(null);
  const setField = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const isSet = kind === 'SET';
  const top = useRef<HTMLFormElement>(null);

  // The set field, or a non-set's name field, is focused once it is on the page: after Save & add
  // next, Change, or a switch between a set and a non-set.
  useEffect(() => {
    if (focusSet > 0) (setField.current ?? nameField.current)?.focus();
  }, [focusSet]);

  // The text the field holds now, so an answer for older text is never shown.
  const currentText = useRef('');
  currentText.current = query.trim();

  // The search: from two characters, after the pause `searchDelayMs` gives the text. Newer text
  // aborts the search before it, in the browser and, through the request's signal, on the
  // server. Offline, and on the shell, nothing is sent.
  useEffect(() => {
    const trimmed = query.trim();
    if (offlineShell || online === false || kind !== 'SET' || chosen !== null || trimmed.length < SEARCH_MIN_LENGTH) {
      setResults([]);
      setResultsFor(null);
      setSearch('idle');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearch('searching');
      searchSets(trimmed, { signal: controller.signal }).then(
        (answer) => {
          if (controller.signal.aborted || currentText.current !== trimmed) return;
          setResults(answer.status === 'ok' ? answer.sets : []);
          setResultsFor(trimmed);
          setSearch(answer.status === 'unavailable' ? 'unavailable' : answer.partial === true ? 'partial' : 'ok');
        },
        () => undefined,
      );
    }, searchDelayMs(trimmed));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, chosen, offlineShell, online, kind]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Text that reads as a set number saves without a pick: as the result that is exactly that set
  // when the current results hold it, otherwise as typed, normalized, and resolved when it syncs.
  const typedText = query.trim();
  const typedNumber = isSet && chosen === null && looksLikeSetNumber(typedText) ? normalizeSetNumber(typedText) : null;
  const exactResult = typedNumber === null || resultsFor !== typedText ? undefined : results.find((set) => set.setNum.toLowerCase() === typedNumber.toLowerCase());
  const setNum = isSet ? (chosen?.setNum ?? exactResult?.setNum ?? typedNumber ?? '') : '';

  /** Logs the item as a non-set (#202): the name starts as the typed text, and the yes/no fields as not stated. */
  function logAs(next: OtherKind): void {
    lastOther.current = next;
    if (kind === 'SET') {
      if (name.trim() === '') setName(chosen === null ? typedText : chosen.name);
      // Left as a fresh set's, they become a non-set's default: not stated.
      if (complete === true && missingNotes.trim() === '') setComplete(null);
      if (hasInstructions === true) setHasInstructions(null);
      setProblems({});
      setFocusSet((count) => count + 1);
    }
    setKind(next);
  }

  /** Back to a set: the set field starts as the name, and unstated yes/no fields as a set's yes. */
  function backToSet(): void {
    setKind('SET');
    if (query.trim() === '' && chosen === null) setQuery(name.trim());
    setComplete((value) => value ?? true);
    setHasInstructions((value) => value ?? true);
    setProblems({});
    setFocusSet((count) => count + 1);
  }

  function draft(id: string): ItemDraft {
    return {
      id,
      baseVersion: item?.version ?? null,
      kind,
      setNum,
      name,
      refNo,
      approxParts: approxParts === '' ? null : Number(approxParts),
      approxWeightG: approxWeightG === '' ? null : Number(approxWeightG),
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

  /** Clears the form for the next item, keeping the kind, the condition and the storage location. */
  function clearForNext(): void {
    forgetNewPhotos();
    setChosen(null);
    setQuery('');
    setName('');
    setRefNo('');
    setApproxParts('');
    setApproxWeightG('');
    setResults([]);
    setResultsFor(null);
    setSearch('idle');
    setPhotos([]);
    setSheet(null);
    setComplete(defaultYesNo(kind));
    setMissingNotes('');
    setHasInstructions(defaultYesNo(kind));
    setQuantity('1');
    setDescription('');
    setProblems({});
    setNotice('');
  }

  /**
   * A form that Save & add next cleared, online or on the offline shell, with nothing entered or
   * changed since: no set, no photo, no text, the toggles as cleared, and the condition and storage
   * location it kept. A fresh form, or an edit, is never untouched, so saving it still shows what
   * is missing.
   */
  function untouched(): boolean {
    const kept = clearedWith.current;
    return (
      kept !== null &&
      kept.kind === kind &&
      kept.condition === condition &&
      kept.storageLocation === storageLocation &&
      setNum === '' &&
      query.trim() === '' &&
      name.trim() === '' &&
      refNo.trim() === '' &&
      approxParts === '' &&
      approxWeightG === '' &&
      photos.length === 0 &&
      description.trim() === '' &&
      missingNotes.trim() === '' &&
      complete === defaultYesNo(kind) &&
      hasInstructions === defaultYesNo(kind) &&
      quantity === '1'
    );
  }

  async function save(then: 'next' | 'items'): Promise<void> {
    if (busy || preparing > 0) return;
    // A second submit straight after Save & add next (a double tap, or the keyboard's Go in the
    // set field it focuses) must not flag the emptied form as wrong: it does nothing at all. Save,
    // which only a deliberate tap reaches, has nothing to save and goes back to the items (#147).
    if (untouched()) {
      if (then === 'items') window.location.assign(ITEMS_PATH);
      return;
    }
    const saved = draft(item?.id ?? crypto.randomUUID());
    const found = draftProblems(saved);
    // A name with no set picked has no set number to save: say to pick one.
    if (isSet && found.setNum === 'required' && typedText !== '') found.setNum = 'pickSet';
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
    // Save shows the items only once its own sync has answered, so the server lists what it just
    // stored; offline, or after SAVE_SYNC_WAIT_MS, the set shows there as not synced.
    const synced = nextSync(SAVE_SYNC_WAIT_MS);
    announceQueued();
    if (then === 'items') {
      if (navigator.onLine) await synced;
      window.location.assign(ITEMS_PATH);
      return;
    }
    clearForNext();
    clearedWith.current = { kind, condition, storageLocation };
    setBusy(false);
    setToast(m.toast(isSet ? saved.setNum : saved.name.trim(), saved.photos.length));
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
    const synced = nextSync(SAVE_SYNC_WAIT_MS);
    announceQueued();
    if (navigator.onLine) await synced;
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
          const photo: FormPhoto = {
            kind: 'new',
            key: crypto.randomUUID(),
            bytes,
            url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
          };
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
      {mode === 'edit' ? (
        // At the top, as quiet text: never beside Save, which the fixed action bar keeps at the bottom.
        <div className="form-top-actions">
          <button type="button" className="button button--link button--quiet-danger" disabled={busy} onClick={() => void remove()}>
            {m.delete}
          </button>
        </div>
      ) : null}
      {mode === 'edit' && online === false ? <p className="card">{m.editOffline}</p> : null}
      {notice === '' ? null : (
        <p className="field__error" role="alert">
          {notice}
        </p>
      )}

      {isSet ? null : (
        <section className="section" aria-label={m.kind.label}>
          <fieldset className="choices">
            <legend>{m.kind.label}</legend>
            {OTHER_KINDS.map((option) => (
              <label key={option} className="choice">
                <input type="radio" name="kind" value={option} checked={kind === option} onChange={() => logAs(option)} />
                {m.kind[option]}
              </label>
            ))}
          </fieldset>
          <button type="button" className="button button--link" onClick={backToSet}>
            {m.kind.backToSet}
          </button>
          <label className="field">
            <span className="field__label">{m.name}</span>
            <input
              ref={nameField}
              className="input"
              name="name"
              autoComplete="off"
              maxLength={ITEM_LIMITS.name}
              placeholder={m.namePlaceholder}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              aria-invalid={problems.name !== undefined}
              aria-describedby="name-problem"
            />
            <Problem id="name-problem" problem={problems.name} />
          </label>
          <label className="field">
            <span className="field__label">{m.refNo}</span>
            <input
              className="input"
              name="refNo"
              autoComplete="off"
              autoCapitalize="none"
              maxLength={ITEM_LIMITS.refNo}
              value={refNo}
              onChange={(event) => setRefNo(event.currentTarget.value)}
              aria-describedby="refNo-hint refNo-problem"
            />
            <span className="field__hint" id="refNo-hint">
              {m.refNoHint}
            </span>
            <Problem id="refNo-problem" problem={problems.refNo} />
          </label>
          {kind === 'BULK' ? (
            <>
              <label className="field">
                <span className="field__label">{m.approxParts}</span>
                <input
                  className="input"
                  name="approxParts"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={approxParts}
                  onChange={(event) => setApproxParts(event.currentTarget.value.replace(/[^0-9]/g, ''))}
                  aria-invalid={problems.approxParts !== undefined}
                  aria-describedby="approxParts-problem"
                />
                <Problem id="approxParts-problem" problem={problems.approxParts} />
              </label>
              <label className="field">
                <span className="field__label">{m.approxWeight}</span>
                <input
                  className="input"
                  name="approxWeightG"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={approxWeightG}
                  onChange={(event) => setApproxWeightG(event.currentTarget.value.replace(/[^0-9]/g, ''))}
                  aria-invalid={problems.approxWeightG !== undefined}
                  aria-describedby="approxWeightG-problem"
                />
                <Problem id="approxWeightG-problem" problem={problems.approxWeightG} />
              </label>
            </>
          ) : null}
        </section>
      )}

      {!isSet ? null : (
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
          ) : (
            <>
              <label className="field">
                <span className="field__label">{m.search.label}</span>
                <input
                  ref={setField}
                  className="input"
                  type="search"
                  name="set"
                  autoComplete="off"
                  autoCapitalize="none"
                  placeholder={m.search.placeholder}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  // Enter or the keyboard's Go never submits the whole set from this field; typing searches.
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  enterKeyHint="search"
                  aria-invalid={problems.setNum !== undefined}
                  aria-describedby="set-hint set-problem"
                />
                <span className="field__hint" id="set-hint">
                  {typedNumber === null ? '' : exactResult !== undefined ? m.search.willSave(exactResult.setNum) : m.search.willResolve(typedNumber)}
                </span>
                <Problem id="set-problem" problem={problems.setNum} />
              </label>
              <button type="button" className="button button--link" onClick={() => logAs(lastOther.current)}>
                {m.search.notASet}
              </button>
              {search === 'searching' ? <p className="muted">{m.search.searching}</p> : null}
              {search === 'unavailable' ? <p className="muted">{m.search.unavailable}</p> : null}
              {search === 'partial' ? <p className="muted">{m.search.partial}</p> : null}
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
                          setResultsFor(null);
                          setSearch('idle');
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {typedText === '' || typedNumber !== null ? null : (
                // A name with no set picked may not be a set at all (#202).
                <div className="row" role="group" aria-labelledby="log-as-label">
                  <span id="log-as-label" className="field__label">
                    {m.kind.logAs}
                  </span>
                  {OTHER_KINDS.map((option) => (
                    <button key={option} type="button" className="button" onClick={() => logAs(option)}>
                      {m.kind[option]}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

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

        <YesNo name="complete" label={m.complete} value={complete} onChange={setComplete} unset={!isSet} />
        {complete !== false ? null : (
          <label className="field">
            <span className="field__label">{m.missing}</span>
            <input className="input" name="missingNotes" maxLength={ITEM_LIMITS.missingNotes} value={missingNotes} onChange={(event) => setMissingNotes(event.currentTarget.value)} />
            <Problem id="missingNotes-problem" problem={problems.missingNotes} />
          </label>
        )}
        <YesNo name="hasInstructions" label={m.instructions} value={hasInstructions} onChange={setHasInstructions} unset={!isSet} />

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
