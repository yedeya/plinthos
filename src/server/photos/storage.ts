/**
 * The photo module's storage interface: the one way `./photos.ts` reaches the private photo
 * bucket. Deployed, it is S3 (`./aws.ts`); in the tests, a stand-in, since CI has no AWS.
 *
 * `guardedStorage` wraps whichever one is used with the rules no caller may get round ([PHOTO-3],
 * [PHOTO-6], [PHOTO-7]): an upload is presigned only for a key under the quarantine prefix, and
 * the server writes only outside it, and a presigned read is never issued for a key under it.
 * Every key it is handed must be one the server made, of the shape `./keys.ts` gives.
 */
import { isQuarantineKey, QUARANTINE_KEY, STORED_KEY } from './keys';

/** A presigned POST: the address the phone posts its form to, and the fields the form must carry. */
export interface PresignedUpload {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface UploadConditions {
  /** The largest body S3 accepts for the upload, in bytes. */
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
  readonly contentType: string;
}

/** What reading an object came to: never more than the cap is read into memory. */
export type ReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'too-large'; readonly bytes: number }
  | { readonly status: 'read'; readonly body: Uint8Array };

export interface PhotoStorage {
  /** Presigns a POST of one object at `key`, which S3 refuses past the conditions. */
  presignUpload(key: string, conditions: UploadConditions): Promise<PresignedUpload>;
  /** Reads an object, refusing to read one larger than `maxBytes`. */
  read(key: string, maxBytes: number): Promise<ReadResult>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deletes an object; a missing one is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Moves a deleted photo's stored size to the trash (`trashKeyFor`): copies it there, then deletes
   * it, so it stays recoverable until the trash's lifecycle rule removes it ([PHOTO-9]). A missing
   * one is not an error. Nothing reads, serves or presigns the trash.
   */
  trash(key: string): Promise<void>;
  /** A presigned GET of one object, valid for `expiresInSeconds`. */
  presignRead(key: string, expiresInSeconds: number): Promise<string>;
}

/** Thrown when a caller asks the storage for something the photo rules forbid. */
export class StorageRuleError extends Error {
  override name = 'StorageRuleError';
}

function ensure(condition: boolean, message: string): void {
  if (!condition) throw new StorageRuleError(message);
}

/** The most a presigned URL may live: 15 minutes ([PHOTO-6], [PHOTO-7]). */
export const MAX_PRESIGN_SECONDS = 15 * 60;

/** Holds any storage to the photo rules. */
export function guardedStorage(storage: PhotoStorage): PhotoStorage {
  return {
    async presignUpload(key, conditions) {
      ensure(QUARANTINE_KEY.test(key), 'an upload is presigned only for a server-made key under the quarantine prefix');
      ensure(conditions.expiresInSeconds > 0 && conditions.expiresInSeconds <= MAX_PRESIGN_SECONDS, 'a presigned upload expires within 15 minutes');
      ensure(Number.isSafeInteger(conditions.maxBytes) && conditions.maxBytes > 0, 'a presigned upload has a size cap');
      return storage.presignUpload(key, conditions);
    },
    async read(key, maxBytes) {
      ensure(QUARANTINE_KEY.test(key) || STORED_KEY.test(key), 'only a server-made key is read');
      return storage.read(key, maxBytes);
    },
    async put(key, body, contentType) {
      ensure(STORED_KEY.test(key) && !isQuarantineKey(key), 'the server writes only stored sizes, outside the quarantine prefix');
      return storage.put(key, body, contentType);
    },
    async delete(key) {
      ensure(QUARANTINE_KEY.test(key) || STORED_KEY.test(key), 'only a server-made key is deleted');
      return storage.delete(key);
    },
    async trash(key) {
      ensure(STORED_KEY.test(key), 'only a stored size goes to the trash; a quarantined upload is deleted');
      return storage.trash(key);
    },
    async presignRead(key, expiresInSeconds) {
      ensure(!isQuarantineKey(key), 'nothing under the quarantine prefix is ever served, presigned or not');
      ensure(STORED_KEY.test(key), 'only a stored size is served');
      ensure(expiresInSeconds > 0 && expiresInSeconds <= MAX_PRESIGN_SECONDS, 'a presigned read expires within 15 minutes');
      return storage.presignRead(key, expiresInSeconds);
    },
  };
}
