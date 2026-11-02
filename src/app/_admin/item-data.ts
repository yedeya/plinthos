/**
 * The admin pages' read of the items (`[ITEM-8]`, `[ITEM-9]`): Issue B's `listItems` and
 * `getItem` (`src/server/items/items.ts`, #127), with each photo's stored key presigned for the
 * page through `presignStoredPhoto` (`src/server/photos/photos.ts`, [PHOTO-6]). Server code only:
 * the pages call it inside `adminPage`, with the `AdminContext` the check issued.
 *
 * **STAND-INS until #127 (PR #131) merges.** The three functions marked `STAND-IN` below take the
 * place of B's, which are not on this branch: `listServerItems` lists nothing and
 * `getServerItem` finds nothing, so `/admin` shows an empty list and `/admin/items/[id]` a
 * not-found until then, and `presignStoredPhoto` presigns as B's does. The reconciliation is this
 * file alone: delete the stand-ins and the two interfaces, and import B's three functions.
 */
import type { AdminContext } from '../../server/auth/admin-context';
import { photosBucket, s3PhotoStorage } from '../../server/photos/aws';
import { READ_EXPIRY_SECONDS } from '../../server/photos/config';
import { guardedStorage, type PhotoStorage } from '../../server/photos/storage';
import type { CatalogueSet, Condition, EditableItem, ListedItem } from '../_offline/items';

/** An item as B's `listItems` answers it: no storage location. */
interface ServerListedItem {
  readonly id: string;
  readonly setNum: string;
  readonly name: string;
  readonly condition: Condition;
  readonly quantity: number;
  readonly coverThumbnailKey: string | null;
  readonly version: number;
  readonly createdAt: string;
}

/** An item as B's `getItem` answers it: its `ItemRecord`, its set and its photos in order. */
interface ServerItem {
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
  readonly set: CatalogueSet;
  readonly photos: readonly { readonly id: string; readonly position: number; readonly thumbnailKey: string; readonly fullKey: string }[];
}

// STAND-IN (#127): `import { getItem as getServerItem, listItems as listServerItems } from '../../server/items/items';`
async function listServerItems(admin: AdminContext, options: { readonly filter?: string }): Promise<ServerListedItem[]> {
  void admin;
  void options;
  return [];
}

// STAND-IN (#127): see `listServerItems`.
async function getServerItem(admin: AdminContext, id: string): Promise<ServerItem | null> {
  void admin;
  void id;
  return null;
}

let storage: PhotoStorage | undefined;

// STAND-IN (#127): `import { presignStoredPhoto } from '../../server/photos/photos';`
async function presignStoredPhoto(admin: AdminContext, key: string): Promise<string> {
  void admin;
  storage ??= guardedStorage(s3PhotoStorage(photosBucket()));
  return storage.presignRead(key, READ_EXPIRY_SECONDS);
}

/** The owner's items, newest first, each cover presigned. */
export async function listItems(admin: AdminContext, options: { readonly filter?: string } = {}): Promise<ListedItem[]> {
  const items = await listServerItems(admin, options);
  return Promise.all(
    items.map(async (item) => ({
      id: item.id,
      setNum: item.setNum,
      name: item.name,
      condition: item.condition,
      quantity: item.quantity,
      version: item.version,
      coverThumbnailUrl: item.coverThumbnailKey === null ? null : await presignStoredPhoto(admin, item.coverThumbnailKey),
    })),
  );
}

/** One item with its set and its photos in order, each presigned, or null when there is none. */
export async function getItem(admin: AdminContext, id: string): Promise<EditableItem | null> {
  const item = await getServerItem(admin, id);
  if (item === null) return null;
  const photos = [...item.photos].sort((a, b) => a.position - b.position);
  const coverId = item.coverPhotoId ?? photos[0]?.id ?? null;
  return {
    id: item.id,
    version: item.version,
    set: item.set,
    condition: item.condition,
    complete: item.complete,
    missingNotes: item.missingNotes,
    hasInstructions: item.hasInstructions,
    description: item.description,
    quantity: item.quantity,
    storageLocation: item.storageLocation,
    photos: await Promise.all(photos.map(async (photo) => ({ id: photo.id, cover: photo.id === coverId, thumbnailUrl: await presignStoredPhoto(admin, photo.thumbnailKey) }))),
  };
}
