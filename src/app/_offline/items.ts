/**
 * The phone's half of set entry (brief #124, Issue C): every shape the entry form, the item list
 * and the offline shell depend on, and the mutations a saved item becomes in the device's queue.
 *
 * **This is the one module that names Issue B's (#127, PR #131) interface on the client**: the
 * mutation names and inputs (`saveItem`, `deleteItem`, `setItemPhotos`, `registerPhoto`'s
 * `itemId` and `position`), their refusal codes, the set search route and its answer, as
 * `src/server/items/items.ts` and `src/server/photos/photos.ts` declare them there. It imports nothing of the server's but the shared constants
 * of `limits.ts`, so the device's bundle and the data-free shell take it ([SYNC-6]).
 *
 * The queue order for an item is `[ITEM-7]`'s: its `saveItem` first, then each new photo's
 * `registerPhoto` carrying the item's id and the photo's place. The server gives a photo its id
 * when it stores it, so the phone can never name a photo it has not stored yet: the cover is
 * therefore always the first photo (**Make cover** moves a photo to the front), the server's own
 * default, and `setItemPhotos` is queued only for an edit that reordered the photos the server
 * already stores. A batch is applied in queue order and
 * ends at the first mutation not applied ([SYNC-4]), so the photos never arrive before their item.
 */
import { PHOTO_MUTATION } from '../../server/sync/limits';
import { sha256Hex } from './photos';
import type { NewMutation, OfflineQueue, QueuedEntry } from './queue';

/** The mutation names Issue B registers (`src/server/sync/mutations.ts`). */
export const ITEM_MUTATION = {
  save: 'saveItem',
  delete: 'deleteItem',
  setPhotos: 'setItemPhotos',
  /** The walking skeleton's, which deletes a stored photo and its sizes. */
  deletePhoto: 'deletePhoto',
  /** The walking skeleton's, which gains an optional `itemId` and `position` ([ITEM-6]). */
  registerPhoto: PHOTO_MUTATION,
} as const;

/** The admin route that searches the set catalogue (`src/app/admin/api/sets/search/route.ts`, #127). */
export const SET_SEARCH_ENDPOINT = '/admin/api/sets/search';

/** The code with which `saveItem` refuses a set number the catalogue does not know ([ITEM-4]). */
export const UNKNOWN_SET = 'unknown-set';

/** The codes with which `setItemPhotos` refuses an item that is gone, or a photo that is not the item's ([ITEM-6]). */
export const UNKNOWN_ITEM = 'unknown-item';
export const PHOTO_NOT_ON_ITEM = 'photo-not-on-item';

/** How long the form waits after the last keystroke before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

/** The fewest characters a search is sent with. */
export const SEARCH_MIN_LENGTH = 2;

/** The most results the form shows. */
export const SEARCH_MAX_RESULTS = 10;

/** How long a search may take before the form says search is unavailable ([CAT-5]). */
export const SEARCH_TIMEOUT_MS = 8_000;

/** The limits `[ITEM-1]` puts on an item's fields. */
export const ITEM_LIMITS = { setNum: 40, description: 2000, missingNotes: 2000, storageLocation: 200, quantityMin: 1, quantityMax: 999, photos: 100 } as const;

export const CONDITIONS = ['SEALED', 'USED_WITH_BOX', 'USED_NO_BOX'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** A set as the catalogue knows it ([CAT-1]): Issue A's `CatalogueSet`. */
export interface CatalogueSet {
  readonly setNum: string;
  readonly name: string;
  readonly theme: string | null;
  readonly year: number | null;
  readonly numParts: number | null;
  readonly imageUrl: string | null;
}

/** What the set search route answers ([CAT-5]). */
export type SetSearchResult = { readonly status: 'ok'; readonly sets: readonly CatalogueSet[] } | { readonly status: 'unavailable' };

/** `saveItem`'s input ([ITEM-1], [ITEM-3]): its `baseVersion` is in the input, null to create. */
export interface SaveItemInput {
  readonly id: string;
  readonly baseVersion: number | null;
  readonly setNum: string;
  readonly condition: Condition;
  readonly complete: boolean;
  /** Dropped by the server when the set is complete. */
  readonly missingNotes?: string | null;
  readonly hasInstructions: boolean;
  readonly description: string;
  readonly quantity: number;
  readonly storageLocation: string;
}

/** `deleteItem`'s input ([ITEM-5]): not versioned, and deleting an item that is gone changes nothing. */
export interface DeleteItemInput {
  readonly id: string;
}

/**
 * `setItemPhotos`'s input ([ITEM-6]): the item's stored photos in their new order, a photo left
 * out keeping its place after them, and the cover, the first photo when left out. It never
 * changes the item's version.
 */
export interface SetItemPhotosInput {
  readonly itemId: string;
  readonly photoIds: readonly string[];
  readonly coverPhotoId?: string | null;
}

/**
 * `registerPhoto`'s input as an item's photo queues it; the quarantine key joins it when it is
 * sent (`./replay.ts`). Without a position the server places it after the item's last photo.
 */
export interface ItemPhotoInput {
  readonly sha256: string;
  readonly itemId: string;
  readonly position?: number;
}

/** An item in the list on `/admin` ([ITEM-8]), as the server lists it with its cover presigned. */
export interface ListedItem {
  readonly id: string;
  readonly setNum: string;
  readonly name: string;
  readonly condition: Condition;
  readonly quantity: number;
  readonly coverThumbnailUrl: string | null;
  readonly version: number;
}

/** A stored photo of an item being edited, in the item's order. */
export interface StoredItemPhoto {
  readonly id: string;
  readonly thumbnailUrl: string;
  readonly cover: boolean;
}

/** An item as the edit form opens it ([ITEM-9]): every `[ITEM-1]` field, its set and its photos in order. */
export interface EditableItem {
  readonly id: string;
  readonly version: number;
  readonly set: CatalogueSet;
  readonly condition: Condition;
  readonly complete: boolean;
  readonly missingNotes: string | null;
  readonly hasInstructions: boolean;
  readonly description: string;
  readonly quantity: number;
  readonly storageLocation: string;
  readonly photos: readonly StoredItemPhoto[];
}

/** A photo on the form: one taken on this device, or one the server already stores. */
export type DraftPhoto =
  | { readonly kind: 'new'; readonly key: string; readonly bytes: ArrayBuffer }
  | { readonly kind: 'stored'; readonly key: string; readonly id: string };

/** What the form holds when it is saved. */
export interface ItemDraft {
  readonly id: string;
  /** The item's version the edit was made against, null for a new item. */
  readonly baseVersion: number | null;
  readonly setNum: string;
  readonly condition: Condition | null;
  readonly complete: boolean;
  readonly missingNotes: string;
  readonly hasInstructions: boolean;
  readonly description: string;
  readonly quantity: number;
  readonly storageLocation: string;
  /** In the order the owner set; the first is the cover. */
  readonly photos: readonly DraftPhoto[];
}

/** What an edited item had before the edit: its stored photos in order, and its cover. */
export interface ItemOriginal {
  readonly photoIds: readonly string[];
  readonly coverId: string | null;
}

/**
 * A typed set number as the catalogue spells it: trimmed, with Rebrickable's `-1` variant added
 * when the owner typed none (`10294` is `10294-1`), as the server does too.
 */
export function normalizeSetNumber(typed: string): string {
  const trimmed = typed.trim();
  return trimmed === '' || /-\d+$/.test(trimmed) ? trimmed : `${trimmed}-1`;
}

/** Whether a typed set number is one `saveItem` takes: 1 to 40 characters, a letter or digit first. */
export function isSetNumber(typed: string): boolean {
  const trimmed = typed.trim();
  return trimmed.length <= ITEM_LIMITS.setNum && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed);
}

export type DraftField = 'setNum' | 'condition' | 'quantity' | 'description' | 'missingNotes' | 'storageLocation';
export type DraftProblem = 'required' | 'setNumber' | 'quantity' | 'tooLong';

/** What is wrong with a draft, field by field, shown inline under each field ([ITEM-9]). Empty when it can be saved. */
export function draftProblems(draft: ItemDraft): Partial<Record<DraftField, DraftProblem>> {
  const problems: Partial<Record<DraftField, DraftProblem>> = {};
  if (draft.setNum === '') problems.setNum = 'required';
  else if (!isSetNumber(draft.setNum)) problems.setNum = 'setNumber';
  if (draft.condition === null) problems.condition = 'required';
  if (!Number.isInteger(draft.quantity) || draft.quantity < ITEM_LIMITS.quantityMin || draft.quantity > ITEM_LIMITS.quantityMax) problems.quantity = 'quantity';
  if (draft.description.length > ITEM_LIMITS.description) problems.description = 'tooLong';
  if (!draft.complete && draft.missingNotes.length > ITEM_LIMITS.missingNotes) problems.missingNotes = 'tooLong';
  if (draft.storageLocation.trim().length > ITEM_LIMITS.storageLocation) problems.storageLocation = 'tooLong';
  return problems;
}

/** `saveItem`'s input for a draft that has no problems. */
export function saveItemInput(draft: ItemDraft): SaveItemInput {
  if (draft.condition === null) throw new Error('a draft without a condition cannot be saved');
  const notes = draft.missingNotes.trim();
  return {
    id: draft.id,
    baseVersion: draft.baseVersion,
    setNum: draft.setNum,
    condition: draft.condition,
    complete: draft.complete,
    ...(draft.complete ? {} : { missingNotes: notes === '' ? null : notes }),
    hasInstructions: draft.hasInstructions,
    description: draft.description.trim(),
    quantity: draft.quantity,
    storageLocation: draft.storageLocation.trim(),
  };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The mutations a saved draft becomes, in the order they are queued ([ITEM-7]):
 *
 * 1. `saveItem`, with the version the edit was made against in its input (null to create);
 * 2. for an edit, `deletePhoto` for each stored photo the owner removed;
 * 3. for an edit whose stored photos are in a new order, `setItemPhotos` with that order, its
 *    first photo the cover;
 * 4. each new photo's `registerPhoto`, with the item's id: for a new item at its place, the first
 *    of them its cover; for an edit after the stored ones, in the order the owner set.
 *
 * The form keeps an edit's new photos after its stored ones (`photoMoves`), so this is the order
 * the owner sees.
 */
export async function itemMutations(draft: ItemDraft, original?: ItemOriginal): Promise<NewMutation[]> {
  const mutations: NewMutation[] = [{ name: ITEM_MUTATION.save, input: saveItemInput(draft) }];

  const stored = draft.photos.flatMap((photo) => (photo.kind === 'stored' ? [photo.id] : []));
  if (original !== undefined) {
    const kept = new Set(stored);
    for (const photoId of original.photoIds) {
      if (!kept.has(photoId)) mutations.push({ name: ITEM_MUTATION.deletePhoto, input: { photoId } });
    }
    // Without a reorder the server keeps the remaining photos in their order, and a removed cover
    // passes to the next one ([ITEM-6]); with one, the order and the cover are sent.
    const remaining = original.photoIds.filter((id) => kept.has(id));
    const keptCover = original.coverId !== null && kept.has(original.coverId) ? original.coverId : remaining[0];
    if (stored.length > 0 && (!sameOrder(stored, remaining) || keptCover !== stored[0])) {
      const input: SetItemPhotosInput = { itemId: draft.id, photoIds: stored, coverPhotoId: stored[0] ?? null };
      mutations.push({ name: ITEM_MUTATION.setPhotos, input });
    }
  }

  for (const [position, photo] of draft.photos.entries()) {
    if (photo.kind !== 'new') continue;
    const input: ItemPhotoInput = { sha256: await sha256Hex(photo.bytes), itemId: draft.id, ...(original === undefined ? { position } : {}) };
    mutations.push({ name: ITEM_MUTATION.registerPhoto, input, upload: { bytes: photo.bytes } });
  }
  return mutations;
}

/**
 * Where a photo may move on the form: within its own group. A new item's photos are all new and
 * move freely; an edit's stored photos stay ahead of its new ones, since the phone can't name a
 * photo the server has not stored yet, and only a stored photo can become an edit's cover.
 */
export function photoMoves(photos: readonly Pick<DraftPhoto, 'kind'>[], index: number): { readonly left: boolean; readonly right: boolean; readonly cover: boolean } {
  const photo = photos[index];
  if (photo === undefined) return { left: false, right: false, cover: false };
  const sameKind = (other: number) => photos[other]?.kind === photo.kind;
  const firstStored = photos.some((other) => other.kind === 'stored');
  return { left: index > 0 && sameKind(index - 1), right: index < photos.length - 1 && sameKind(index + 1), cover: index > 0 && (photo.kind === 'stored' || !firstStored) };
}

/** Queues a saved draft, all its mutations in one IndexedDB transaction, so none is queued without the others. */
export async function queueItem(queue: OfflineQueue, draft: ItemDraft, original?: ItemOriginal): Promise<QueuedEntry[]> {
  return queue.enqueueAll(await itemMutations(draft, original));
}

/** Queues an item's deletion ([ITEM-5]). */
export async function queueItemDeletion(queue: OfflineQueue, id: string): Promise<QueuedEntry> {
  const input: DeleteItemInput = { id };
  return queue.enqueue({ name: ITEM_MUTATION.delete, input });
}

/** An item still in the device's queue, as the list shows it ([ITEM-8]). */
export interface QueuedItem {
  readonly id: string;
  readonly setNum: string;
  readonly condition: Condition;
  readonly quantity: number;
  /** Whether it is a new item, rather than a change to one the server holds. */
  readonly created: boolean;
  /** Whether it is a deletion. */
  readonly deleted: boolean;
  /** Whether a mutation of it is held for the owner ([SYNC-8]). */
  readonly held: boolean;
  /** How many of its photos are queued with it. */
  readonly photos: number;
}

function isSaveInput(input: unknown): input is SaveItemInput {
  const value = input as Partial<SaveItemInput> | null;
  return typeof value?.id === 'string' && typeof value.setNum === 'string' && typeof value.quantity === 'number' && CONDITIONS.includes(value.condition as Condition);
}

/** The items the device's queue still holds, newest first: what the list marks as not synced. */
export function queuedItems(entries: readonly QueuedEntry[]): QueuedItem[] {
  const items = new Map<string, { -readonly [K in keyof QueuedItem]: QueuedItem[K] }>();
  for (const entry of entries) {
    if (entry.name === ITEM_MUTATION.save && isSaveInput(entry.input)) {
      const { id, setNum, condition, quantity } = entry.input;
      const before = items.get(id);
      items.set(id, { id, setNum, condition, quantity, created: before?.created ?? entry.input.baseVersion === null, deleted: false, held: (before?.held ?? false) || entry.held !== undefined, photos: before?.photos ?? 0 });
      continue;
    }
    const input = entry.input as { id?: unknown; itemId?: unknown } | null;
    const itemId = entry.name === ITEM_MUTATION.delete ? input?.id : input?.itemId;
    const item = typeof itemId === 'string' ? items.get(itemId) : undefined;
    if (item === undefined) continue;
    if (entry.name === ITEM_MUTATION.delete) item.deleted = true;
    if (entry.name === ITEM_MUTATION.registerPhoto) item.photos++;
    if (entry.held !== undefined) item.held = true;
  }
  return [...items.values()].reverse();
}

/** Whether a listed item matches what the owner typed in the filter: by set number or by name. */
export function matchesFilter(item: { readonly setNum: string; readonly name?: string }, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return true;
  return item.setNum.toLowerCase().includes(needle) || (item.name ?? '').toLowerCase().includes(needle);
}

function isCatalogueSet(value: unknown): value is CatalogueSet {
  const set = value as Partial<CatalogueSet> | null;
  return typeof set?.setNum === 'string' && typeof set.name === 'string';
}

/**
 * Searches the set catalogue through the admin's route. Anything but a well-formed `ok` answer, a
 * failed request, a timeout or an ended session included, is `unavailable`, so the form falls
 * back to a typed set number and never shows an error page ([CAT-5]).
 */
export async function searchSets(query: string, options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<SetSearchResult> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  try {
    const response = await send(`${SET_SEARCH_ENDPOINT}?${new URLSearchParams({ q: query.trim() })}`, { credentials: 'same-origin', cache: 'no-store', signal });
    if (!response.ok) return { status: 'unavailable' };
    const body = (await response.json()) as { status?: unknown; sets?: unknown };
    if (body.status !== 'ok' || !Array.isArray(body.sets)) return { status: 'unavailable' };
    return { status: 'ok', sets: body.sets.filter(isCatalogueSet).slice(0, SEARCH_MAX_RESULTS) };
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    return { status: 'unavailable' };
  }
}
