/**
 * The photo path's service functions (`AGENTS.md` §1 and §4, brief #6, Issue J and decision 18).
 *
 * A photo reaches the server in three steps the phone's queue runs (`src/app/_offline/`):
 *
 * 1. `presignPhotoUpload` makes a random key under the private bucket's quarantine prefix and
 *    presigns a POST of it that S3 refuses past the size cap or after 10 minutes ([PHOTO-1],
 *    [PHOTO-7]). Only the signed-in admin can call it (the presign route is an admin route).
 * 2. The phone posts the bytes straight to S3, never through the admin's server function.
 * 3. The `registerPhoto` mutation replays through the offline-sync endpoint. It reads the
 *    quarantined object, refuses it if it is over the cap, if its SHA-256 is not the mutation's,
 *    or if it is not a JPEG sharp can decode; re-encodes it into the full size and the thumbnail;
 *    writes only those, under fresh random keys outside the quarantine prefix; and records the
 *    photo. It writes the files before the transaction that records the photo and its applied id
 *    commits, so a failure leaves orphaned private files and never a photo without its files
 *    ([PHOTO-3]).
 *
 * Once that transaction has ended, whatever it came to, the registry's `settled` deletes the
 * quarantined object the mutation named: applied, already applied (a retry that uploaded the
 * same photo again), a conflict, refused, or failed (#9). The uploaded bytes are never kept or
 * served. A refusal is answered `invalid` with a code; `upload-missing` tells the phone, which
 * keeps the bytes until the photo is applied, to upload it again under the same id (#9).
 *
 * `photo.reencode.failed` logs a refused upload with the mutation's id and why, never its bytes
 * ([PHOTO-5]); `photo.cleanup.failed` logs a file a delete or a move to the trash left behind. Neither pages
 * (`docs/observability.md`).
 *
 * A photo registered with an `itemId` joins that item's photos, and becomes its cover when the
 * item has none; deleting an item's cover makes its next photo the cover ([ITEM-6],
 * `../items/covers.ts`).
 *
 * A photo registered with `partsLot: true` joins the parts lot's overview photos, at most
 * `MAX_PARTS_PHOTOS` of them ([PARTS-5], #161); one more is refused as `parts-photos-full` before
 * anything is stored. A photo belongs to an item or to the parts lot, never both: the input
 * refuses both at once, and so does the database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { collectionItem } from '../../db/schema/collection-item';
import { photo } from '../../db/schema/photo';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { coverIfNone, nextPosition, replaceCover } from '../items/covers';
import { logger as defaultLogger, type Logger } from '../logger';
import { PHOTO_BUDGET_MS, PHOTO_MUTATION } from '../sync/limits';
import { MutationRefused, syncMutation, type SyncMutation } from '../sync/registry';
import { afterCommit, db, inTransaction } from '../transaction';
import { photosBucket, s3PhotoStorage } from './aws';
import { photoSettings, READ_EXPIRY_SECONDS, UPLOAD_EXPIRY_SECONDS, type PhotoSettings } from './config';
import { QUARANTINE_KEY, quarantineKey, storedKey } from './keys';
import { reencodePhoto, UndecodablePhoto } from './reencode';
import { guardedStorage, type PhotoStorage } from './storage';

/** The content type the presigned upload requires: the phone re-compresses every photo as JPEG ([PHOTO-1]). */
export const UPLOAD_CONTENT_TYPE = 'image/jpeg';
export const STORED_CONTENT_TYPE = 'image/webp';

/** The refusal codes `registerPhoto` answers with. Only `upload-missing` is worth an automatic retry. */
export const REFUSALS = {
  missing: 'upload-missing',
  tooLarge: 'too-large',
  hash: 'hash-mismatch',
  undecodable: 'undecodable',
  partsPhotosFull: 'parts-photos-full',
} as const;

/** The most overview photos the parts lot has ([PARTS-5]). */
export const MAX_PARTS_PHOTOS = 12;

/**
 * The transaction-level advisory lock the parts lot's writers take, so that two imports, or two
 * overview photos, never interleave ([PARTS-3], [PARTS-5]). Released when the transaction ends.
 */
export const PARTS_LOCK = 153_161;

export const PresignInput = z.strictObject({});

export const RegisterPhotoInput = z
  .strictObject({
  /** The key `presignPhotoUpload` made, under the quarantine prefix. */
  quarantineKey: z.string().regex(QUARANTINE_KEY),
  /** The SHA-256 of the bytes the phone uploaded, as lowercase hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The item the photo belongs to, when it was taken for one ([ITEM-6], [ITEM-7]). The photo is
   * linked when the item exists, and stored unlinked when it doesn't.
   */
  itemId: z.uuid().optional(),
  /** Its place among the item's photos, or the parts lot's, from 0; after the last one when left out. */
  position: z.number().int().min(0).max(999).optional(),
  /** True for one of the parts lot's overview photos ([PARTS-5]). */
  partsLot: z.literal(true).optional(),
  })
  .refine((input) => !(input.partsLot === true && input.itemId !== undefined), {
    message: 'a photo belongs to an item or to the parts lot, never both',
    path: ['partsLot'],
  });

export const DeletePhotoInput = z.strictObject({ photoId: z.uuid() });

export interface PresignedPhotoUpload {
  readonly key: string;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly expiresAt: string;
}

export interface RegisteredPhoto {
  readonly photoId: string;
  /** The item the photo was linked to, when the mutation named one that exists. */
  readonly itemId?: string;
  /** True when the photo joined the parts lot's overview photos. */
  readonly partsLot?: true;
}

export interface ListedPhoto {
  readonly id: string;
  readonly createdAt: string;
  /** Presigned GETs, each valid for 10 minutes ([PHOTO-6]). */
  readonly thumbnailUrl: string;
  readonly fullUrl: string;
}

export interface PhotoDependencies {
  readonly storage: () => PhotoStorage;
  readonly settings?: () => PhotoSettings;
  readonly now?: () => Date;
  readonly log?: Logger;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds the photo service functions over a storage; deployed code uses the ones below. */
export function createPhotoService(dependencies: PhotoDependencies) {
  const storage = () => guardedStorage(dependencies.storage());
  const settings = dependencies.settings ?? (() => photoSettings());
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;

  const presignPhotoUpload = adminOperation(PresignInput, async (): Promise<PresignedPhotoUpload> => {
    const { maxBytes } = settings();
    const key = quarantineKey();
    const expiresAt = new Date(now().getTime() + UPLOAD_EXPIRY_SECONDS * 1000).toISOString();
    const { url, fields } = await storage().presignUpload(key, { maxBytes, expiresInSeconds: UPLOAD_EXPIRY_SECONDS, contentType: UPLOAD_CONTENT_TYPE });
    return { key, url, fields, maxBytes, expiresAt };
  });

  /**
   * Re-encodes and records one quarantined upload ([PHOTO-3]). It does not delete the quarantined
   * object: that follows the end of its caller's transaction, which the offline-sync replay runs
   * through `settled` below.
   */
  const registerPhoto = adminOperation(RegisterPhotoInput, async (_admin, input): Promise<RegisteredPhoto> => {
    const { maxBytes, longestEdge } = settings();
    // The parts lot's count first, under its lock, so a 13th photo stores nothing.
    let partsPosition: number | undefined;
    if (input.partsLot === true) {
      await db().execute(sql`select pg_advisory_xact_lock(${PARTS_LOCK})`);
      const [row] = await db()
        .select({ count: sql<number>`count(*)`, last: sql<number | null>`max(${photo.position})` })
        .from(photo)
        .where(eq(photo.partsLot, true));
      if (Number(row?.count ?? 0) >= MAX_PARTS_PHOTOS) {
        throw new MutationRefused(REFUSALS.partsPhotosFull, [`the parts lot has its ${MAX_PARTS_PHOTOS} photos already: delete one first`]);
      }
      const last = row?.last;
      partsPosition = input.position ?? (last === null || last === undefined ? 0 : Number(last) + 1);
    }
    const read = await storage().read(input.quarantineKey, maxBytes);
    if (read.status === 'missing') {
      throw new MutationRefused(REFUSALS.missing, ['quarantineKey: the upload is not in the quarantine any more: upload the photo again']);
    }
    if (read.status === 'too-large') {
      throw new MutationRefused(REFUSALS.tooLarge, [`the upload is ${read.bytes} bytes, over the cap of ${maxBytes}`]);
    }
    if (sha256(read.body) !== input.sha256) {
      throw new MutationRefused(REFUSALS.hash, ['sha256: the uploaded bytes do not have the hash the mutation names']);
    }
    let encoded;
    try {
      encoded = await reencodePhoto(read.body, { longestEdge });
    } catch (error) {
      if (error instanceof UndecodablePhoto) throw new MutationRefused(REFUSALS.undecodable, ['the upload is not a JPEG the server can decode']);
      throw error;
    }
    // The files first, then the row: a failure after this leaves orphaned private files, never a
    // photo without its files.
    const fullKey = storedKey();
    const thumbnailKey = storedKey();
    await storage().put(fullKey, encoded.full.body, STORED_CONTENT_TYPE);
    await storage().put(thumbnailKey, encoded.thumbnail.body, STORED_CONTENT_TYPE);
    const photoId = randomUUID();
    const createdAt = now();
    if (partsPosition !== undefined) {
      await db().insert(photo).values({ id: photoId, fullKey, thumbnailKey, sha256: input.sha256, createdAt, partsLot: true, position: partsPosition });
      return { photoId, partsLot: true };
    }
    const item =
      input.itemId === undefined
        ? undefined
        : (await db().select({ id: collectionItem.id }).from(collectionItem).where(eq(collectionItem.id, input.itemId)).for('update'))[0];
    if (item === undefined) {
      await db().insert(photo).values({ id: photoId, fullKey, thumbnailKey, sha256: input.sha256, createdAt });
      return { photoId };
    }
    const position = input.position ?? (await nextPosition(item.id));
    await db().insert(photo).values({ id: photoId, fullKey, thumbnailKey, sha256: input.sha256, createdAt, itemId: item.id, position });
    await coverIfNone(item.id, photoId);
    return { photoId, itemId: item.id };
  });

  /** Deletes one photo: its row now, and moves its files to the trash once that has committed ([PHOTO-9]). Deleting one that is gone changes nothing. */
  const deletePhoto = adminOperation(DeletePhotoInput, async (admin, input): Promise<{ readonly photoId: string; readonly deleted: boolean }> =>
    inTransaction(async () => {
      const [gone] = await db()
        .delete(photo)
        .where(eq(photo.id, input.photoId))
        .returning({ fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey, itemId: photo.itemId, position: photo.position });
      if (gone === undefined) return { photoId: input.photoId, deleted: false };
      // Deleting the cover makes the next photo the cover ([ITEM-6]).
      if (gone.itemId !== null) await replaceCover(gone.itemId, gone.position);
      afterCommit(async () => {
        for (const key of [gone.fullKey, gone.thumbnailKey]) {
          try {
            await storage().trash(key);
          } catch (error) {
            log.error(
              { businessEvent: 'photo.cleanup.failed', photoId: input.photoId, requestId: admin.requestId, cause: (error as Error).name },
              'a deleted photo’s stored size could not be moved to the trash; it stays private and unserved',
            );
          }
        }
      });
      return { photoId: input.photoId, deleted: true };
    }),
  );

  /** The stored photos, newest first, each with presigned URLs ([PHOTO-6]). Only the signed-in admin sees them. */
  async function listPhotos(admin: AdminContext, options: { readonly limit?: number } = {}): Promise<ListedPhoto[]> {
    assertAdmin(admin);
    const rows = await db()
      .select({ id: photo.id, createdAt: photo.createdAt, fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey })
      .from(photo)
      .orderBy(desc(photo.createdAt))
      .limit(options.limit ?? 100);
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        thumbnailUrl: await storage().presignRead(row.thumbnailKey, READ_EXPIRY_SECONDS),
        fullUrl: await storage().presignRead(row.fullKey, READ_EXPIRY_SECONDS),
      })),
    );
  }

  const mutations: readonly SyncMutation[] = [
    syncMutation({
      name: PHOTO_MUTATION,
      input: RegisterPhotoInput,
      apply: registerPhoto,
      // The read, the re-encode and the writes: what the batch's time counts it as ([SYNC-11]).
      budgetMs: PHOTO_BUDGET_MS,
      // A re-upload of the same photo under a new key is the same mutation ([PHOTO-2], #9).
      // The item and position are part of what it asks for; left out, they hash as before (#124).
      payloadKey: (input) => ({ sha256: input.sha256, itemId: input.itemId, position: input.position, partsLot: input.partsLot }),
      // Every outcome deletes the quarantined object it was given ([PHOTO-3], [PHOTO-5], #9).
      settled: async (admin, input, settlement) => {
        if (settlement.outcome === 'invalid' && settlement.code !== REFUSALS.missing) {
          log.warn(
            { businessEvent: 'photo.reencode.failed', mutationId: settlement.id, reason: settlement.code ?? 'invalid', requestId: admin.requestId },
            'an uploaded photo was refused and stored nothing',
          );
        }
        if (settlement.outcome === 'failed') {
          log.warn(
            { businessEvent: 'photo.reencode.failed', mutationId: settlement.id, reason: 'failed', requestId: admin.requestId },
            'an uploaded photo failed on the server and stored no photo',
          );
        }
        try {
          await storage().delete(input.quarantineKey);
        } catch (error) {
          log.error(
            { businessEvent: 'photo.cleanup.failed', mutationId: settlement.id, requestId: admin.requestId, cause: (error as Error).name },
            'a quarantined upload could not be deleted; the quarantine’s lifecycle rule expires it within about a day',
          );
        }
      },
    }),
    syncMutation({ name: 'deletePhoto', input: DeletePhotoInput, apply: deletePhoto, republishes: (result) => result.deleted }),
  ];

  /** A presigned GET of one stored size, valid for 10 minutes ([PHOTO-6]), for a page that lists photos by key. */
  async function presignStoredPhoto(admin: AdminContext, key: string): Promise<string> {
    assertAdmin(admin);
    return storage().presignRead(key, READ_EXPIRY_SECONDS);
  }

  return { presignPhotoUpload, registerPhoto, deletePhoto, listPhotos, presignStoredPhoto, mutations };
}

let deployedStorage: PhotoStorage | undefined;

/** The linked photo bucket, which the item service deletes an item's photos' files from too. */
export function deployedPhotoStorage(): PhotoStorage {
  return (deployedStorage ??= s3PhotoStorage(photosBucket()));
}

/** The photo service as deployed: the linked photo bucket and the server function's settings. */
export const photos = createPhotoService({ storage: deployedPhotoStorage });

export const { presignPhotoUpload, registerPhoto, deletePhoto, listPhotos, presignStoredPhoto } = photos;

/** The photo mutations the production registry holds (`../sync/mutations.ts`). */
export const PHOTO_MUTATIONS = photos.mutations;
