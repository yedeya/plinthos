/**
 * What the public catalogue may show of the loose parts (#161, brief #153, §2): how many lots and
 * parts the last import holds, and the overview photos' stored keys, in order ([PARTS-5]). The
 * publish step (#162) calls `readPartsSummary` through its own executor. It reads no unit price,
 * no value, no currency and nothing of a lot: per-lot data is the valuation milestone's (#5).
 *
 * It imports nothing of the photo storage, so the publish step can read it without the bucket.
 */
import { asc, desc, eq, sql } from 'drizzle-orm';
import { partsImport } from '../../db/schema/parts';
import { photo } from '../../db/schema/photo';
import type { Executor } from '../transaction';

export interface PartsSummary {
  readonly lots: number;
  readonly quantity: number;
  /** The overview photos' stored sizes, in the owner's order: private keys, which the publish step copies, never links. */
  readonly photos: readonly { readonly fullKey: string; readonly thumbnailKey: string }[];
}

/** The order of the parts lot's photos: by position, then by when each was added. */
export const PARTS_PHOTO_ORDER = [sql`${photo.position} asc nulls last`, asc(photo.createdAt), asc(photo.id)] as const;

/** The parts summary, or null when there is no import and no overview photo. */
export async function readPartsSummary(executor: Executor): Promise<PartsSummary | null> {
  const [last] = await executor
    .select({ lots: partsImport.lots, quantity: partsImport.quantity })
    .from(partsImport)
    .orderBy(desc(partsImport.importedAt))
    .limit(1);
  const photos = await executor
    .select({ fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey })
    .from(photo)
    .where(eq(photo.partsLot, true))
    .orderBy(...PARTS_PHOTO_ORDER);
  if (last === undefined && photos.length === 0) return null;
  return { lots: last?.lots ?? 0, quantity: last?.quantity ?? 0, photos };
}
