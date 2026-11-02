/**
 * An item's photo order and its cover ([ITEM-6]), shared by the item functions (`./items.ts`) and
 * the photo functions (`../photos/photos.ts`), which link and delete photos. An item with photos
 * has exactly one cover: the first photo until the owner picks another, and the next photo when
 * the cover is deleted. They read and write through `db()`, so they join the caller's transaction.
 */
import { asc, eq } from 'drizzle-orm';
import { collectionItem } from '../../db/schema/collection-item';
import { photo } from '../../db/schema/photo';
import { db } from '../transaction';

/** An item's photos in their order: by position, then by when each was added. */
export async function orderedPhotos(itemId: string): Promise<{ id: string; thumbnailKey: string; fullKey: string }[]> {
  return db()
    .select({ id: photo.id, thumbnailKey: photo.thumbnailKey, fullKey: photo.fullKey })
    .from(photo)
    .where(eq(photo.itemId, itemId))
    .orderBy(asc(photo.position), asc(photo.createdAt), asc(photo.id));
}

/** Makes the item's first photo its cover when it has none, as when its first photo is linked. */
export async function coverIfNone(itemId: string): Promise<void> {
  const [item] = await db().select({ cover: collectionItem.coverPhotoId }).from(collectionItem).where(eq(collectionItem.id, itemId)).for('update');
  if (item === undefined || item.cover !== null) return;
  const [first] = await orderedPhotos(itemId);
  if (first !== undefined) await db().update(collectionItem).set({ coverPhotoId: first.id }).where(eq(collectionItem.id, itemId));
}

/**
 * Before a photo is deleted: when it is an item's cover, the photo after it in the order becomes
 * the cover, or the first one when it was the last, or none when it was the only one.
 */
export async function releaseCover(photoId: string): Promise<void> {
  const [item] = await db().select({ id: collectionItem.id }).from(collectionItem).where(eq(collectionItem.coverPhotoId, photoId)).for('update');
  if (item === undefined) return;
  const photos = await orderedPhotos(item.id);
  const at = photos.findIndex((candidate) => candidate.id === photoId);
  const rest = photos.filter((candidate) => candidate.id !== photoId);
  const next = (at === -1 ? undefined : photos[at + 1]) ?? rest[0];
  await db()
    .update(collectionItem)
    .set({ coverPhotoId: next?.id ?? null })
    .where(eq(collectionItem.id, item.id));
}
