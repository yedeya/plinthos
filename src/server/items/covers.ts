/**
 * An item's photos and its cover ([ITEM-6]): the rules `registerPhoto`, `deletePhoto`,
 * `setItemPhotos` and `deleteItem` share. An item's photos are ordered by position, then by when
 * they were added; an item with photos has exactly one cover, the first photo until the owner
 * picks another, and deleting the cover makes the next photo the cover.
 *
 * Each runs through `db()`, so it joins its caller's transaction.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { collectionItem } from '../../db/schema/collection-item';
import { photo } from '../../db/schema/photo';
import { db } from '../transaction';

/** The order of an item's photos: by position, then by when each was added. */
export const PHOTO_ORDER = [sql`${photo.position} asc nulls last`, asc(photo.createdAt), asc(photo.id)] as const;

/** An item's photos, in order. */
export async function itemPhotos(itemId: string) {
  return db()
    .select({ id: photo.id, position: photo.position, fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey, createdAt: photo.createdAt })
    .from(photo)
    .where(eq(photo.itemId, itemId))
    .orderBy(...PHOTO_ORDER);
}

/** The position after an item's last photo, for a photo added without one. */
export async function nextPosition(itemId: string): Promise<number> {
  const [row] = await db()
    .select({ last: sql<number | null>`max(${photo.position})` })
    .from(photo)
    .where(eq(photo.itemId, itemId));
  const last = row?.last;
  return last === null || last === undefined ? 0 : Number(last) + 1;
}

/** Makes a photo just linked to an item its cover when the item has none yet. */
export async function coverIfNone(itemId: string, photoId: string): Promise<void> {
  await db()
    .update(collectionItem)
    .set({ coverPhotoId: photoId })
    .where(and(eq(collectionItem.id, itemId), sql`${collectionItem.coverPhotoId} is null`));
}

/**
 * After a photo of an item was deleted: when the item has no cover any more (the key set it to
 * null), the photo after the deleted one becomes the cover, or the first one when it was the last.
 */
export async function replaceCover(itemId: string, deletedPosition: number | null): Promise<void> {
  const [item] = await db().select({ coverPhotoId: collectionItem.coverPhotoId }).from(collectionItem).where(eq(collectionItem.id, itemId)).for('update');
  if (item === undefined || item.coverPhotoId !== null) return;
  const after =
    deletedPosition === null
      ? []
      : await db()
          .select({ id: photo.id })
          .from(photo)
          .where(and(eq(photo.itemId, itemId), gt(photo.position, deletedPosition)))
          .orderBy(...PHOTO_ORDER)
          .limit(1);
  const next = after[0] ?? (await itemPhotos(itemId))[0];
  if (next === undefined) return;
  await db().update(collectionItem).set({ coverPhotoId: next.id }).where(eq(collectionItem.id, itemId));
}
