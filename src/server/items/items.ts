/**
 * The owner's items (#124, [ITEM-1] to [ITEM-6]): the typed service functions the entry form, the
 * offline queue and any later tool share (`AGENTS.md` §4, [SYNC-1]).
 *
 * - `saveItem` creates or updates an item. It is a versioned mutation: its input's `baseVersion`
 *   is null to create the item and the item's version to change it, and the replay answers any
 *   other as a `version` conflict with the server's item ([ITEM-3], [SYNC-3]). A create inserts
 *   without an upsert, and an update changes only the version it names, so a second create of
 *   the same id is refused by the key and answered as a conflict too, never an overwrite
 *   (`racedCreate` in `../sync/replay.ts`). It
 *   resolves the set the item names through `lego_set`, and asks the catalogue for one the table
 *   doesn't hold inside `SET_LOOKUP_BUDGET_MS`: a set the catalogue doesn't know is refused as
 *   `unknown-set`, and a catalogue that can't answer makes the mutation `failed`, so the phone
 *   retries it ([ITEM-4]).
 * - `deleteItem` deletes the item and every photo linked to it, and their stored files once that
 *   has committed, as `deletePhoto` does ([ITEM-5]).
 * - `setItemPhotos` orders an item's photos and picks its cover ([ITEM-6]).
 * - `listItems` and `getItem` read them for the admin's pages.
 *
 * A direct call of `saveItem`, outside the replay, keeps the version rule too: a create of an id
 * that exists fails on the key, and an update of another version throws `ItemVersionConflict`.
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  collectionItem,
  CONDITIONS,
  MAX_DESCRIPTION,
  MAX_MISSING_NOTES,
  MAX_QUANTITY,
  MAX_STORAGE_LOCATION,
  type Condition,
} from '../../db/schema/collection-item';
import { legoSet } from '../../db/schema/lego-set';
import { photo } from '../../db/schema/photo';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { catalogue as deployedCatalogue, SetNum, type CatalogueService, type CatalogueSet } from '../catalogue/sets';
import { logger as defaultLogger, type Logger } from '../logger';
import { deployedPhotoStorage } from '../photos/photos';
import { guardedStorage, type PhotoStorage } from '../photos/storage';
import { MutationRefused, syncMutation, type CurrentVersion, type SyncMutation } from '../sync/registry';
import { afterCommit, db, inTransaction } from '../transaction';
import { itemPhotos } from './covers';

/**
 * What resolving an unknown set may take inside a `saveItem`, retries included. A batch is one
 * request inside the server function's 55-second timeout (`infra/admin.ts`); each mutation
 * commits on its own, so a batch of many new sets that runs out of time still keeps every item it
 * saved, and the phone sends the rest again.
 */
export const SET_LOOKUP_BUDGET_MS = 5_000;

/**
 * Thrown by a direct call of `saveItem` whose base version is not the item's. Through the replay
 * this never happens: its version check runs first, on a locked row, and answers a conflict.
 */
export class ItemVersionConflict extends Error {
  override name = 'ItemVersionConflict';
  constructor(
    readonly itemId: string,
    readonly baseVersion: number,
  ) {
    super(`item ${itemId} is not at version ${baseVersion}`);
  }
}

/** The refusal codes the item mutations answer with ([SYNC-4]). */
export const ITEM_REFUSALS = {
  unknownSet: 'unknown-set',
  unknownItem: 'unknown-item',
  notTheItemsPhoto: 'photo-not-on-item',
} as const;

export const SaveItemInput = z.strictObject({
  /** The client's UUID for the item, made when it was entered ([ITEM-1], [PLAT-13]). */
  id: z.uuid(),
  /** A set number as the catalogue writes it, `10179-1`, or typed without its variant, `10179`. */
  setNum: SetNum,
  condition: z.enum(CONDITIONS),
  complete: z.boolean(),
  /** What is missing; kept only for an item that is not complete. */
  missingNotes: z.string().trim().max(MAX_MISSING_NOTES).nullable().optional(),
  hasInstructions: z.boolean(),
  description: z.string().trim().max(MAX_DESCRIPTION).default(''),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  /** Where the owner keeps it: private, never published ([ITEM-1]). */
  storageLocation: z.string().trim().max(MAX_STORAGE_LOCATION).default(''),
  /**
   * The item's version the change was made against, null to create it ([ITEM-3]). The queued
   * mutation's envelope may carry it too, and must then carry the same.
   */
  baseVersion: z.number().int().positive().nullable(),
});
export type SaveItemInput = z.input<typeof SaveItemInput>;

export const DeleteItemInput = z.strictObject({ id: z.uuid() });
export type DeleteItemInput = z.input<typeof DeleteItemInput>;

export const SetItemPhotosInput = z.strictObject({
  itemId: z.uuid(),
  /**
   * The item's photos in their new order. Each must be the item's; one the list leaves out keeps
   * its place after the listed ones, in its old order.
   */
  photoIds: z
    .array(z.uuid())
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'a photo is listed twice'),
  /** The cover, one of the item's photos; the first photo in the new order when null or left out. */
  coverPhotoId: z.uuid().nullable().optional(),
});
export type SetItemPhotosInput = z.input<typeof SetItemPhotosInput>;

export const ListItemsOptions = z.strictObject({ filter: z.string().max(100).optional() });

/** An item as `saveItem` stored it, and as a conflict answers it: the record, without its photos. */
export interface ItemRecord {
  readonly id: string;
  readonly setNum: string;
  readonly condition: Condition;
  readonly complete: boolean;
  readonly missingNotes: string | null;
  readonly hasInstructions: boolean;
  readonly description: string;
  readonly quantity: number;
  readonly storageLocation: string;
  readonly coverPhotoId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One of an item's photos, in order, by its private keys, which the page presigns ([PHOTO-6]). */
export interface ItemPhoto {
  readonly id: string;
  readonly position: number | null;
  readonly thumbnailKey: string;
  readonly fullKey: string;
}

/** An item as the edit form reads it: the record, its set, and its photos in order. */
export interface Item extends ItemRecord {
  readonly set: CatalogueSet;
  readonly photos: readonly ItemPhoto[];
}

/** One row of the admin's list ([ITEM-8]). */
export interface ListedItem {
  readonly id: string;
  readonly setNum: string;
  readonly name: string;
  readonly condition: Condition;
  readonly quantity: number;
  /** The set's stock image from the catalogue, which the list shows by default; null when it has none. */
  readonly imageUrl: string | null;
  /** The cover's thumbnail key, which the page presigns; null for an item with no photos. */
  readonly coverThumbnailKey: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface SavedItem {
  readonly id: string;
  readonly version: number;
  readonly setNum: string;
  readonly created: boolean;
}

export interface ItemDependencies {
  readonly catalogue: () => CatalogueService;
  /** The photo bucket, for deleting an item's photos' files. */
  readonly storage: () => PhotoStorage;
  readonly now?: () => Date;
  readonly log?: Logger;
}

type ItemRow = typeof collectionItem.$inferSelect;

function record(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    setNum: row.setNum,
    condition: row.condition,
    complete: row.complete,
    missingNotes: row.missingNotes,
    hasInstructions: row.hasInstructions,
    description: row.description,
    quantity: row.quantity,
    storageLocation: row.storageLocation,
    coverPhotoId: row.coverPhotoId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The item's row, locked for the rest of the transaction, or undefined. */
async function lockedItem(id: string): Promise<ItemRow | undefined> {
  const [row] = await db().select().from(collectionItem).where(eq(collectionItem.id, id)).for('update');
  return row;
}

/** Builds the item service functions; deployed code uses the ones below. */
export function createItemService(dependencies: ItemDependencies) {
  const storage = () => guardedStorage(dependencies.storage());
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;

  /** The set an item names: from the table, or looked up when the table doesn't hold it ([ITEM-4]). */
  async function resolveSet(setNum: string): Promise<CatalogueSet> {
    const service = dependencies.catalogue();
    const stored = await service.storedSet(setNum);
    if (stored !== null) return stored;
    // Throws CatalogueUnavailable when the catalogue can't answer: the mutation is failed and retried.
    const found = await service.lookupSet(setNum, { budgetMs: SET_LOOKUP_BUDGET_MS });
    if (found === null) throw new MutationRefused(ITEM_REFUSALS.unknownSet, [`setNum: the set catalogue knows no set ${JSON.stringify(setNum)}`]);
    return found;
  }

  const saveItem = adminOperation(SaveItemInput, async (admin, input): Promise<SavedItem> => {
    const set = await resolveSet(input.setNum);
    const fields = {
      setNum: set.setNum,
      condition: input.condition,
      complete: input.complete,
      missingNotes: input.complete || input.missingNotes === undefined || input.missingNotes === null || input.missingNotes === '' ? null : input.missingNotes,
      hasInstructions: input.hasInstructions,
      description: input.description,
      quantity: input.quantity,
      storageLocation: input.storageLocation,
    };
    const at = now();
    if (input.baseVersion === null) {
      // A plain insert, never an upsert: the key refuses a second create of this id, even one
      // that raced this one past the replay's version check ([ITEM-3]).
      await db()
        .insert(collectionItem)
        .values({ id: input.id, ...fields, version: 1, createdAt: at, updatedAt: at });
      return { id: input.id, version: 1, setNum: set.setNum, created: true };
    }
    // Only the version it was made against: a change against any other changes nothing.
    const [saved] = await db()
      .update(collectionItem)
      .set({ ...fields, version: sql`${collectionItem.version} + 1`, updatedAt: at })
      .where(and(eq(collectionItem.id, input.id), eq(collectionItem.version, input.baseVersion)))
      .returning({ version: collectionItem.version });
    if (saved === undefined) throw new ItemVersionConflict(input.id, input.baseVersion);
    return { id: input.id, version: saved.version, setNum: set.setNum, created: false };
  });

  const deleteItem = adminOperation(
    DeleteItemInput,
    async (admin, input): Promise<{ readonly id: string; readonly deleted: boolean; readonly photosDeleted: number }> =>
      inTransaction(async () => {
        const existing = await lockedItem(input.id);
        if (existing === undefined) return { id: input.id, deleted: false, photosDeleted: 0 };
        const gone = await db()
          .delete(photo)
          .where(eq(photo.itemId, input.id))
          .returning({ id: photo.id, fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey });
        await db().delete(collectionItem).where(eq(collectionItem.id, input.id));
        // The files go once the rows are gone for good, as `deletePhoto` does ([ITEM-5]).
        afterCommit(async () => {
          for (const deleted of gone) {
            for (const key of [deleted.fullKey, deleted.thumbnailKey]) {
              try {
                await storage().delete(key);
              } catch (error) {
                log.error(
                  { businessEvent: 'photo.cleanup.failed', photoId: deleted.id, itemId: input.id, requestId: admin.requestId, cause: (error as Error).name },
                  'a deleted item’s photo’s stored size could not be deleted; it stays private and unserved',
                );
              }
            }
          }
        });
        return { id: input.id, deleted: true, photosDeleted: gone.length };
      }),
  );

  const setItemPhotos = adminOperation(
    SetItemPhotosInput,
    async (_admin, input): Promise<{ readonly itemId: string; readonly photoIds: readonly string[]; readonly coverPhotoId: string | null }> => {
      const item = await lockedItem(input.itemId);
      if (item === undefined) throw new MutationRefused(ITEM_REFUSALS.unknownItem, [`itemId: there is no item ${input.itemId}`]);
      const current = await itemPhotos(input.itemId);
      const own = new Set(current.map(({ id }) => id));
      const foreign = input.photoIds.filter((id) => !own.has(id));
      if (input.coverPhotoId !== undefined && input.coverPhotoId !== null && !own.has(input.coverPhotoId)) foreign.push(input.coverPhotoId);
      if (foreign.length > 0) {
        throw new MutationRefused(
          ITEM_REFUSALS.notTheItemsPhoto,
          foreign.map((id) => `photoIds: photo ${id} is not one of this item’s photos`),
        );
      }
      const listed = new Set(input.photoIds);
      const order = [...input.photoIds, ...current.map(({ id }) => id).filter((id) => !listed.has(id))];
      for (const [position, id] of order.entries()) {
        await db()
          .update(photo)
          .set({ position })
          .where(and(eq(photo.id, id), eq(photo.itemId, input.itemId)));
      }
      const coverPhotoId = input.coverPhotoId ?? order[0] ?? null;
      await db().update(collectionItem).set({ coverPhotoId }).where(eq(collectionItem.id, input.itemId));
      return { itemId: input.itemId, photoIds: order, coverPhotoId };
    },
  );

  /** The owner's items, newest first, filtered by set number or name as the owner types ([ITEM-8]). */
  async function listItems(admin: AdminContext, options: z.input<typeof ListItemsOptions> = {}): Promise<ListedItem[]> {
    assertAdmin(admin);
    const { filter } = ListItemsOptions.parse(options);
    const trimmed = filter?.trim() ?? '';
    const pattern = `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await db()
      .select({
        id: collectionItem.id,
        setNum: collectionItem.setNum,
        name: legoSet.name,
        condition: collectionItem.condition,
        quantity: collectionItem.quantity,
        imageUrl: legoSet.imageUrl,
        coverThumbnailKey: photo.thumbnailKey,
        version: collectionItem.version,
        createdAt: collectionItem.createdAt,
      })
      .from(collectionItem)
      .innerJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum))
      .leftJoin(photo, eq(photo.id, collectionItem.coverPhotoId))
      .where(trimmed === '' ? undefined : or(ilike(collectionItem.setNum, pattern), ilike(legoSet.name, pattern)))
      .orderBy(desc(collectionItem.createdAt), desc(collectionItem.id));
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  /** One item, with its set and its photos in order, or null. */
  async function getItem(admin: AdminContext, id: string): Promise<Item | null> {
    assertAdmin(admin);
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) return null;
    const [row] = await db()
      .select({ item: collectionItem, set: legoSet })
      .from(collectionItem)
      .innerJoin(legoSet, eq(legoSet.setNum, collectionItem.setNum))
      .where(eq(collectionItem.id, parsed.data));
    if (row === undefined) return null;
    const photos = await itemPhotos(row.item.id);
    return {
      ...record(row.item),
      set: { setNum: row.set.setNum, name: row.set.name, theme: row.set.theme, year: row.set.year, numParts: row.set.numParts, imageUrl: row.set.imageUrl },
      photos: photos.map(({ id: photoId, position, thumbnailKey, fullKey }) => ({ id: photoId, position, thumbnailKey, fullKey })),
    };
  }

  /** The item's current version for the replay's check, locking its row ([SYNC-3]). */
  async function currentItemVersion(input: { readonly id: string }): Promise<CurrentVersion | null> {
    const row = await lockedItem(input.id);
    return row === undefined ? null : { version: row.version, record: record(row) };
  }

  const mutations: readonly SyncMutation[] = [
    syncMutation({
      name: 'saveItem',
      input: SaveItemInput,
      apply: saveItem,
      currentVersion: currentItemVersion,
      baseVersionOf: (input) => input.baseVersion,
    }),
    syncMutation({ name: 'deleteItem', input: DeleteItemInput, apply: deleteItem }),
    syncMutation({ name: 'setItemPhotos', input: SetItemPhotosInput, apply: setItemPhotos }),
  ];

  return { saveItem, deleteItem, setItemPhotos, listItems, getItem, mutations };
}

/** The item service as deployed: the deployed set lookup and the linked photo bucket. */
export const items = createItemService({ catalogue: () => deployedCatalogue, storage: deployedPhotoStorage });

export const { saveItem, deleteItem, setItemPhotos, listItems, getItem } = items;

/** The item mutations the production registry holds (`../sync/mutations.ts`). */
export const ITEM_MUTATIONS = items.mutations;
