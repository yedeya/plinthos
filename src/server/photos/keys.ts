/**
 * The photo bucket's two prefixes, and the keys the server makes under them ([PHOTO-6], [PHOTO-7]).
 *
 * - `quarantine/`: where the phone's presigned upload lands. Nothing serves it, a lifecycle rule
 *   expires every object under it after one day (`infra/photos.ts`), and `registerPhoto` deletes
 *   the object it was given whatever it comes to.
 * - `photos/`: the re-encoded sizes, the only files the server writes.
 *
 * Every key is made by the server from 256 bits of `crypto.randomBytes`, never from the client's
 * id or anything else the client sent, so a key can't be guessed or enumerated.
 */
import { randomBytes } from 'node:crypto';

export const QUARANTINE_PREFIX = 'quarantine/';
export const STORED_PREFIX = 'photos/';

/** The random part of a key: 32 bytes, as 43 characters of base64url. */
const RANDOM = '[A-Za-z0-9_-]{43}';

/** A key the presign route makes under the quarantine prefix. */
export const QUARANTINE_KEY = new RegExp(`^${QUARANTINE_PREFIX}${RANDOM}\\.jpg$`);

/** A key `registerPhoto` makes for a stored size. */
export const STORED_KEY = new RegExp(`^${STORED_PREFIX}${RANDOM}\\.webp$`);

function random(): string {
  return randomBytes(32).toString('base64url');
}

/** A fresh key under the quarantine prefix, for one presigned upload. */
export function quarantineKey(): string {
  return `${QUARANTINE_PREFIX}${random()}.jpg`;
}

/** A fresh key for one stored size. */
export function storedKey(): string {
  return `${STORED_PREFIX}${random()}.webp`;
}

/** Whether a key is under the quarantine prefix, which nothing may read through a presigned URL or write to but the phone. */
export function isQuarantineKey(key: string): boolean {
  return key.startsWith(QUARANTINE_PREFIX);
}
