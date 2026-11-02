/**
 * The photo path's settings ([PHOTO-1]): the longest edge the phone resizes to, and the size cap
 * the presigned upload and `registerPhoto` both hold a photo to. The deployment configures both
 * (`infra/config.ts`, `docs/deploy.md`); `infra/admin.ts` hands them to the server function's
 * environment, and the admin page hands the longest edge to the phone.
 */

export const LONGEST_EDGE_ENV = 'PLINTHOS_PHOTO_LONGEST_EDGE';
export const MAX_BYTES_ENV = 'PLINTHOS_PHOTO_MAX_BYTES';

/** The defaults, which `infra/config.ts` uses too. */
export const DEFAULT_LONGEST_EDGE = 2048;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** The bounds a deployment may set them within. */
export const LONGEST_EDGE_RANGE = { min: 320, max: 8192 } as const;
export const MAX_BYTES_RANGE = { min: 64 * 1024, max: 20 * 1024 * 1024 } as const;

/** The thumbnail's longest edge: the second stored size, beside the full size. */
export const THUMBNAIL_EDGE = 320;

/** How long a presigned upload, and a presigned read of a stored size, stays valid: under 15 minutes ([PHOTO-6], [PHOTO-7]). */
export const UPLOAD_EXPIRY_SECONDS = 600;
export const READ_EXPIRY_SECONDS = 600;

export interface PhotoSettings {
  readonly longestEdge: number;
  readonly maxBytes: number;
}

function whole(value: string | undefined, fallback: number, range: { readonly min: number; readonly max: number }): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= range.min && parsed <= range.max ? parsed : fallback;
}

/** The deployed settings, from the server function's environment, or the defaults. */
export function photoSettings(env: Readonly<Record<string, string | undefined>> = process.env): PhotoSettings {
  return {
    longestEdge: whole(env[LONGEST_EDGE_ENV], DEFAULT_LONGEST_EDGE, LONGEST_EDGE_RANGE),
    maxBytes: whole(env[MAX_BYTES_ENV], DEFAULT_MAX_BYTES, MAX_BYTES_RANGE),
  };
}
