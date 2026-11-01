/**
 * The catalogue token: the unguessable part of the public catalogue's address, `/c/{token}/`
 * (`AGENTS.md` §1, `HANDOVER.md` §4.3). It is a capability, not content, so it is the path the
 * snapshot is written under and never a value inside it (`[PUB-4]`), and it is classified private
 * (`src/db/schema/classification.ts`).
 *
 * It is 32 bytes from the operating system's secure generator, 256 bits, in base64url, so it is
 * URL-safe without escaping ([PUB-7]). A token read back from the database is checked against the
 * same shape before it becomes part of an object key, so a hand-edited value can never address
 * anything outside its own prefix. Rotation is a later item (brief #6, §2).
 */
import { randomBytes } from 'node:crypto';

declare const brand: unique symbol;

/** A token of the shape below: the only kind of string a snapshot key is built from. */
export type CatalogueToken = string & { readonly [brand]: true };

/** The bytes of entropy in a token: 256 bits, twice `AGENTS.md` §1's floor of 128. */
export const TOKEN_BYTES = 32;

/** 32 bytes in unpadded base64url are 43 characters of `A-Z`, `a-z`, `0-9`, `-` and `_`. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export class InvalidCatalogueTokenError extends Error {
  override name = 'InvalidCatalogueTokenError';
}

/** Makes a new token from the secure generator ([PUB-7]). */
export function generateCatalogueToken(): CatalogueToken {
  return randomBytes(TOKEN_BYTES).toString('base64url') as CatalogueToken;
}

export function isCatalogueToken(value: unknown): value is CatalogueToken {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

/** Refuses a value that is not a token, without echoing it: an error message reaches the logs. */
export function asCatalogueToken(value: unknown): CatalogueToken {
  if (!isCatalogueToken(value)) {
    throw new InvalidCatalogueTokenError('The stored catalogue token is not 43 base64url characters: refusing to publish under it.');
  }
  return value;
}
