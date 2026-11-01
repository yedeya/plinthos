/**
 * The admin's password hash ([AUTH-2], brief #6, decision 13): scrypt from `node:crypto`, which
 * is memory-hard and needs no native module, with its parameters stored beside the hash.
 *
 * The format is `scrypt:ln=<log2 N>,r=<r>,p=<p>:<salt>:<key>`, the salt and the key in
 * base64url. It holds no character a shell expands, so it can be set as an SST secret as it is.
 * `npm run --silent auth:hash-password` prints one (`scripts/hash-password.ts`, docs/deploy.md).
 *
 * Checking a password compares the derived key in constant time and never calls the database.
 * The plaintext is never stored, logged or returned: these functions take it and give back only
 * a hash or a boolean.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** The parameters a new hash gets: N = 2^17, r = 8, p = 1, 128 MiB of memory (OWASP's floor). */
export const DEFAULT_PARAMETERS = { ln: 17, r: 8, p: 1 } as const;

/** The parameters a stored hash may name: a hash outside them is refused, not computed. */
const BOUNDS = { ln: [10, 20], r: [1, 32], p: [1, 16] } as const;

const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface PasswordHash {
  readonly ln: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

const FORMAT = /^scrypt:ln=(\d+),r=(\d+),p=(\d+):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{32,})$/;

function within(value: number, [low, high]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/** Reads a stored hash, or null when it is not one this module makes. */
export function parsePasswordHash(value: string): PasswordHash | null {
  const match = FORMAT.exec(value.trim());
  if (match === null) return null;
  const [ln, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!within(ln, BOUNDS.ln) || !within(r, BOUNDS.r) || !within(p, BOUNDS.p)) return null;
  const salt = Buffer.from(match[4] ?? '', 'base64url');
  const key = Buffer.from(match[5] ?? '', 'base64url');
  if (salt.length < SALT_BYTES || key.length < KEY_BYTES) return null;
  return { ln, r, p, salt, key };
}

function derive(password: string, salt: Buffer, ln: number, r: number, p: number, length: number): Promise<Buffer> {
  const N = 2 ** ln;
  // scrypt needs 128 · N · r bytes; Node refuses more than its 32 MiB default unless told.
  const options: ScryptOptions = { N, r, p, maxmem: 128 * N * r * 2 };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFC'), salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Hashes a password with a fresh salt. */
export async function hashPassword(
  password: string,
  parameters: { ln: number; r: number; p: number } = DEFAULT_PARAMETERS,
): Promise<string> {
  if (password.length === 0) throw new Error('The password is empty.');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, parameters.ln, parameters.r, parameters.p, KEY_BYTES);
  return `scrypt:ln=${parameters.ln},r=${parameters.r},p=${parameters.p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

/** Whether `password` is the one `hash` was made from, compared in constant time. */
export async function verifyPassword(password: string, hash: PasswordHash): Promise<boolean> {
  const key = await derive(password, hash.salt, hash.ln, hash.r, hash.p, hash.key.length);
  return timingSafeEqual(key, hash.key);
}
