/**
 * The admin pages' read of the items (`[ITEM-8]`, `[ITEM-9]`): `listItems` and `getItem`
 * (`src/server/items/items.ts`), with each photo's stored key presigned for the page through
 * `presignStoredPhoto` (`src/server/photos/photos.ts`, [PHOTO-6]), into the shapes the client
 * components take (`../_offline/items.ts`). Server code only: the pages call it inside
 * `adminPage`, with the `AdminContext` the check issued.
 */
import type { AdminContext } from '../../server/auth/admin-context';
import { getItem as getServerItem, listItems as listServerItems } from '../../server/items/items';
import { presignStoredPhoto } from '../../server/photos/photos';
import type { EditableItem, ListedItem } from '../_offline/items';

/** The owner's items, newest first, each cover presigned. */
export async function listItems(admin: AdminContext, options: { readonly filter?: string } = {}): Promise<ListedItem[]> {
  const items = await listServerItems(admin, options);
  return Promise.all(
    items.map(async (item) => ({
      id: item.id,
      kind: item.kind,
      setNum: item.setNum,
      name: item.name,
      refNo: item.refNo,
      condition: item.condition,
      quantity: item.quantity,
      version: item.version,
      stockImageUrl: item.imageUrl,
      coverThumbnailUrl: item.coverThumbnailKey === null ? null : await presignStoredPhoto(admin, item.coverThumbnailKey),
    })),
  );
}

/** One item with its set (null for a non-set) and its photos in order, each presigned, or null when there is none. */
export async function getItem(admin: AdminContext, id: string): Promise<EditableItem | null> {
  const item = await getServerItem(admin, id);
  if (item === null) return null;
  // The server lists them in order already; a photo without a place stays after those with one.
  const photos = [...item.photos].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  const coverId = item.coverPhotoId ?? photos[0]?.id ?? null;
  return {
    id: item.id,
    version: item.version,
    kind: item.kind,
    set: item.set,
    name: item.name,
    refNo: item.refNo,
    approxParts: item.approxParts,
    approxWeightG: item.approxWeightG,
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
