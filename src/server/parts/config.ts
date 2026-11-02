/**
 * The parts import's size cap ([PARTS-2], #161): the largest parts file the presigned upload and
 * `importPartsFile` both accept. The deployment configures it (`infra/config.ts`,
 * `docs/deploy.md`), and `infra/admin.ts` hands it to the server function's environment.
 */

export const PARTS_MAX_BYTES_ENV = 'PLINTHOS_PARTS_MAX_BYTES';

/** The default and the bounds, which `infra/config.ts` uses too. */
export const DEFAULT_PARTS_MAX_BYTES = 20 * 1024 * 1024;
export const PARTS_MAX_BYTES_RANGE = { min: 64 * 1024, max: 50 * 1024 * 1024 } as const;

/** How long a presigned parts upload stays valid: 10 minutes, under the 15 the storage allows ([PARTS-2]). */
export const PARTS_UPLOAD_EXPIRY_SECONDS = 600;

/** The deployed cap, from the server function's environment, or the default. */
export function partsMaxBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = env[PARTS_MAX_BYTES_ENV]?.trim();
  if (value === undefined || value === '') return DEFAULT_PARTS_MAX_BYTES;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= PARTS_MAX_BYTES_RANGE.min && parsed <= PARTS_MAX_BYTES_RANGE.max ? parsed : DEFAULT_PARTS_MAX_BYTES;
}
