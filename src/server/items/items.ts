/**
 * The collection item's service functions (#133, [ITEM-1] to [ITEM-6], `AGENTS.md` §4).
 *
 * - `saveItem` creates or updates an item. It is a versioned record ([SYNC-3], [ITEM-3]): the
 *   offline-sync replay checks the mutation's base version against the item's, under a lock, and
 *   hands the function the version it checked. A create inserts without an upsert, so the item's
 *   primary key refuses a racing second create, which the replay answers as a `version` conflict.
 *   An item's set must be in `lego_set`: one that isn't is looked up within `LOOKUP_BUDGET_MS`
 *   ([ITEM-4]). A set the catalogue doesn't know is refused as `unknown-set`, which holds the
 *   mutation on `/admin` for the owner; a catalogue failure throws, so the mutation is `failed`
 *   and the phone retries it.
 * - `deleteItem` deletes the item and its photos, and their stored sizes once that has committed
 *   ([ITEM-5]), as `deletePhoto` does.
 * - `setItemPhotos` sets the order and the cover of an item's photos, and refuses a photo that
 *   isn't the item's ([ITEM-6]). `registerPhoto` links a photo to an item (`../photos/photos.ts`).
 * - `listItems` and `getItem` read items for the admin's pages, with presigned photo URLs
 *   ([PHOTO-6]).
 *
 * `saveItem`, `deleteItem` and `setItemPhotos` are the registered sync mutations
 * (`../sync/mutations.ts`), so the entry form, the offline queue and later tools all go through
 * them ([ITEM-2], [SYNC-1]).
 */
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { collectionItem } from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { photo } from '../../db/schema/photo';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { catalogue, LOOKUP_BUDGET_MS, normalizeSetNum, SET_NUM, type CatalogueService } from '../catalogue/sets';
import { logger as defaultLogger, type Logger } from '../logger';
import { READ_EXPIRY_SECONDS } from '../photos/config';
import { deployedPhotoStorage } from '../photos/photos';
import { guardedStorage, type PhotoStorage } from '../photos/storage';
import { MutationRefused, syncMutation, type SyncMutation, type VersionCheck } from '../sync/registry';
import { afterCommit, db, inTransaction } from '../transaction';
import { orderedPhotos } from './cover';

export const CONDITIONS = ['SEALED', 'USED_WITH_BOX', 'USED_NO_BOX'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** The refusal codes the item functions answer with; none is worth an automatic retry. */
export const ITEM_REFUSALS = {
  unknownSet: 'unknown-set',
  unknownItem: 'unknown-item',
  notItemPhoto: 'not-item-photo',
} as const;

/** The most items a list answers with; the collection is a few hundred sets. */
export const LIST_LIMIT = 1_000;

/** Optional free text: trimmed, at most `max` characters, and null when empty. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));

export const SaveItemInput = z.strictObject({
  /** The client's UUID for the item, made when the owner started the entry ([PLAT-13]). */
  id: z.uuid(),
  /** A set number; a bare number is read as its first variant (`normalizeSetNum`). */
  setNum: z.string().trim().min(1).max(40).regex(SET_NUM),
  condition: z.enum(CONDITIONS),
  complete: z.boolean(),
  /** What is missing; kept only for an incomplete item. */
  missingNote: optionalText(2_000),
  hasInstructions: z.boolean(),
  description: optionalText(2_000),
  quantity: z.number().int().min(1).max(999),
  storageLocation: optionalText(200),
});

export const DeleteItemInput = z.strictObject({ itemId: z.uuid() });

export const SetItemPhotosInput = z.strictObject({
  itemId: z.uuid(),
  /** The item's photos in their new order; any of its photos not named keep their order after these. */
  photoIds: z
    .array(z.uuid())
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, 'a photo is named more than once'),
  /** The cover, one of the item's photos; null for the first in the new order. */
  coverPhotoId: z.uuid().nullable(),
});

export const ListItemsInput = z.strictObject({ filter: z.string().max(200).optional() });

/** An item as the service answers it: its fields and its set's. What a conflict shows the client ([ITEM-3]). */
export interface ItemRecord {
  readonly id: string;
  readonly setNum: string;
  readonly name: string;
  readonly theme: string;
  readonly year: number;
  readonly numParts: number;
  readonly imageUrl: string | null;
  readonly condition: Condition;
  readonly complete: boolean;
  readonly missingNote: string | null;
  readonly hasInstructions: boolean;
  readonly description: string | null;
  readonly quantity: number;
  readonly storageLocation: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One row of the item list ([ITEM-8]). */
export interface ListedItem {
  readonly id: string;
  readonly setNum: string;
  readonly name: string;
  readonly condition: Condition;
  readonly quantity: number;
  readonly version: number;
  readonly createdAt: string;
  /** A presigned GET of the cover's thumbnail ([PHOTO-6]), or null when the item has no photo. */
  readonly coverThumbnailUrl: string | null;
}

export interface ItemPhoto {
  readonly id: string;
  readonly isCover: boolean;
  /** Presigned GETs ([PHOTO-6]). */
  readonly thumbnailUrl: string;
  readonly fullUrl: string;
}

export interface ItemWithPhotos extends ItemRecord {
  /** In their order. */
  readonly photos: readonly ItemPhoto[];
}

export interface ItemDependencies {
  /** The private photo bucket, for the presigned URLs and the files `deleteItem` deletes. */
  readonly storage: () => PhotoStorage;
  /** The set lookup `saveItem` resolves a set it doesn't hold through ([ITEM-4]). */
  readonly catalogue: () => Pick<CatalogueService, 'lookupSet'>;
  readonly now?: () => Date;
  readonly log?: Logger;
}

/** Escapes LIKE's wildcards and its escape character, so a filter matches as typed. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** Reads one item with its set's fields, optionally locking the item's row for the version check. */
export async function readItem(id: string, options: { readonly lock?: boolean } = {}): Promise<ItemRecord | null> {
  const query = db().select().from(collectionItem).where(eq(collectionItem.id, id));
  const [item] = options.lock === true ? await query.for('update') : await query;
  if (item === undefined) return null;
  const [set] = await db().select().from(legoSet).where(eq(legoSet.setNum, item.setNum));
  if (set === undefined) throw new Error('an item has no catalogue row, which its foreign key forbids');
  return {
    id: item.id,
    setNum: item.setNum,
    name: set.name,
    theme: set.theme,
    year: set.year,
    numParts: set.numParts,
    imageUrl: set.imageUrl,
    condition: item.condition as Condition,
    complete: item.complete,
    missingNote: item.missingNote,
    hasInstructions: item.hasInstructions,
    description: item.description,
    quantity: item.quantity,
    storageLocation: item.storageLocation,
    version: item.version,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

/** Builds the item service functions; deployed code uses the ones below. */
export function createItemService(dependencies: ItemDependencies) {
  const storage = () => guardedStorage(dependencies.storage());
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;

  /** The set number as `lego_set` holds it, looked up when it doesn't ([ITEM-4]). */
  async function resolveSet(typed: string): Promise<string> {
    const setNum = normalizeSetNum(typed);
    const [held] = await db().select({ setNum: legoSet.setNum }).from(legoSet).where(eq(legoSet.setNum, setNum));
    if (held !== undefined) return held.setNum;
    // A catalogue failure throws: the mutation is `failed`, and the phone retries it ([SYNC-8]).
    const found = await dependencies.catalogue().lookupSet(setNum, { budgetMs: LOOKUP_BUDGET_MS });
    if (found === null) throw new MutationRefused(ITEM_REFUSALS.unknownSet, [`setNum: the set catalogue does not know the set ${setNum}`]);
    return found.setNum;
  }

  /**
   * Creates or updates an item ([ITEM-2], [ITEM-3]). With a null base version it creates the
   * item, and the primary key refuses one that already exists; with a version it updates the item
   * only at that version.
   */
  async function saveItem(admin: AdminContext, rawInput: z.input<typeof SaveItemInput>, version: VersionCheck): Promise<ItemRecord> {
    assertAdmin(admin);
    const input = SaveItemInput.parse(rawInput);
    const setNum = await resolveSet(input.setNum);
    const fields = {
      setNum,
      condition: input.condition,
      complete: input.complete,
      missingNote: input.complete ? null : input.missingNote,
      hasInstructions: input.hasInstructions,
      description: input.description,
      quantity: input.quantity,
      storageLocation: input.storageLocation,
    };
    const at = now();
    if (version.baseVersion === null) {
      // Never an upsert: a second create of this id must fail on the key ([ITEM-3]).
      await db()
        .insert(collectionItem)
        .values({ id: input.id, ...fields, version: 1, createdAt: at, updatedAt: at });
    } else {
      const [updated] = await db()
        .update(collectionItem)
        .set({ ...fields, version: version.baseVersion + 1, updatedAt: at })
        .where(and(eq(collectionItem.id, input.id), eq(collectionItem.version, version.baseVersion)))
        .returning({ id: collectionItem.id });
      if (updated === undefined) throw new Error('the item is not at the version the change was made against');
    }
    const saved = await readItem(input.id);
    if (saved === null) throw new Error('the saved item could not be read back');
    return saved;
  }

  /** Deletes an item and its photos, and their stored sizes once that has committed ([ITEM-5]). */
  const deleteItem = adminOperation(DeleteItemInput, async (admin, input): Promise<{ readonly itemId: string; readonly deleted: boolean }> =>
    inTransaction(async () => {
      // Locked first, so a `registerPhoto` linking a photo to it waits, then finds it gone.
      const [item] = await db().select({ id: collectionItem.id }).from(collectionItem).where(eq(collectionItem.id, input.itemId)).for('update');
      if (item === undefined) return { itemId: input.itemId, deleted: false };
      const gone = await db().delete(photo).where(eq(photo.itemId, item.id)).returning({ id: photo.id, fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey });
      await db().delete(collectionItem).where(eq(collectionItem.id, item.id));
      afterCommit(async () => {
        for (const deleted of gone) {
          for (const key of [deleted.fullKey, deleted.thumbnailKey]) {
            try {
              await storage().delete(key);
            } catch (error) {
              log.error(
                { businessEvent: 'photo.cleanup.failed', photoId: deleted.id, requestId: admin.requestId, cause: (error as Error).name },
                'a deleted item’s photo’s stored size could not be deleted; it stays private and unserved',
              );
            }
          }
        }
      });
      return { itemId: item.id, deleted: true };
    }),
  );

  /** Sets the order and the cover of an item's photos ([ITEM-6]). */
  const setItemPhotos = adminOperation(SetItemPhotosInput, async (_admin, input): Promise<{ readonly itemId: string; readonly photoIds: readonly string[]; readonly coverPhotoId: string | null }> =>
    inTransaction(async () => {
      const [item] = await db().select({ id: collectionItem.id }).from(collectionItem).where(eq(collectionItem.id, input.itemId)).for('update');
      if (item === undefined) throw new MutationRefused(ITEM_REFUSALS.unknownItem, ['itemId: no item has this id']);
      const current = (await orderedPhotos(item.id)).map((each) => each.id);
      const owned = new Set(current);
      const foreign = [...input.photoIds, ...(input.coverPhotoId === null ? [] : [input.coverPhotoId])].filter((id) => !owned.has(id));
      if (foreign.length > 0) throw new MutationRefused(ITEM_REFUSALS.notItemPhoto, foreign.map((id) => `photoIds: the photo ${id} is not this item’s`));
      const named = new Set(input.photoIds);
      const order = [...input.photoIds, ...current.filter((id) => !named.has(id))];
      for (const [position, id] of order.entries()) {
        await db().update(photo).set({ position }).where(eq(photo.id, id));
      }
      const coverPhotoId = input.coverPhotoId ?? order[0] ?? null;
      await db().update(collectionItem).set({ coverPhotoId }).where(eq(collectionItem.id, item.id));
      return { itemId: item.id, photoIds: order, coverPhotoId };
    }),
  );

  /** The owner's items, newest first, filtered by set number or name ([ITEM-8]). */
  async function listItems(admin: AdminContext, rawInput: z.input<typeof ListItemsInput>): Promise<ListedItem[]> {
    assertAdmin(admin);
    const { filter } = ListItemsInput.parse(rawInput);
    const text = filter?.trim() ?? '';
    const rows = await db()
      .select({
        id: collectionItem.id,
        setNum: collectionItem.setNum,
        name: legoSet.name,
        condition: collectionItem.condition,
        quantity: collectionItem.quantity,
        version: collectionItem.version,
        createdAt: collectionItem.createdAt,
        thumbnailKey: photo.thumbnailKey,
      })
      .from(collectionItem)
      .innerJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum))
      .leftJoin(photo, eq(photo.id, collectionItem.coverPhotoId))
      .where(text === '' ? undefined : or(ilike(collectionItem.setNum, likePattern(text)), ilike(legoSet.name, likePattern(text))))
      .orderBy(desc(collectionItem.createdAt), desc(collectionItem.id))
      .limit(LIST_LIMIT);
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        setNum: row.setNum,
        name: row.name,
        condition: row.condition as Condition,
        quantity: row.quantity,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        coverThumbnailUrl: row.thumbnailKey === null ? null : await storage().presignRead(row.thumbnailKey, READ_EXPIRY_SECONDS),
      })),
    );
  }

  /** One item with its photos in their order, for the edit form; null when there is none. */
  async function getItem(admin: AdminContext, id: string): Promise<ItemWithPhotos | null> {
    assertAdmin(admin);
    const itemId = z.uuid().parse(id);
    const item = await readItem(itemId);
    if (item === null) return null;
    const [cover] = await db().select({ id: collectionItem.coverPhotoId }).from(collectionItem).where(eq(collectionItem.id, itemId));
    const photos = await Promise.all(
      (await orderedPhotos(itemId)).map(async (each) => ({
        id: each.id,
        isCover: each.id === cover?.id,
        thumbnailUrl: await storage().presignRead(each.thumbnailKey, READ_EXPIRY_SECONDS),
        fullUrl: await storage().presignRead(each.fullKey, READ_EXPIRY_SECONDS),
      })),
    );
    return { ...item, photos };
  }

  const mutations: readonly SyncMutation[] = [
    syncMutation({
      name: 'saveItem',
      input: SaveItemInput,
      apply: saveItem,
      // The item, locked, so no other change moves its version before this one applies ([ITEM-3]).
      currentVersion: async (input) => {
        const current = await readItem(input.id, { lock: true });
        return current === null ? null : { version: current.version, record: current };
      },
    }),
    syncMutation({ name: 'deleteItem', input: DeleteItemInput, apply: deleteItem }),
    syncMutation({ name: 'setItemPhotos', input: SetItemPhotosInput, apply: setItemPhotos }),
  ];

  return { saveItem, deleteItem, setItemPhotos, listItems, getItem, mutations };
}

/** The item service as deployed: the linked photo bucket, and the set lookup over Rebrickable. */
export const items = createItemService({ storage: deployedPhotoStorage, catalogue: () => catalogue });

export const { saveItem, deleteItem, setItemPhotos, listItems, getItem } = items;

/** The item mutations the production registry holds (`../sync/mutations.ts`). */
export const ITEM_MUTATIONS = items.mutations;
