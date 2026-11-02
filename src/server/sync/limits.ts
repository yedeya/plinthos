/**
 * How much photo work one offline-sync batch may carry ([SYNC-10], #95). Both halves of the
 * replay read it: the device ends a batch before the photo that would pass the cap
 * (`src/app/_offline/replay.ts`), and the endpoint refuses a batch that carries more
 * (`./replay.ts`). It imports nothing, so the device's bundle takes it without the server's code.
 *
 * Each `registerPhoto` reads its upload from S3, re-encodes it into every stored size and writes
 * them back, one after another in the one invocation that runs the batch
 * (`src/server/photos/photos.ts`). The cap keeps that inside the admin's server function's
 * timeout, `SERVER_TIMEOUT` in `infra/admin.ts`, however many photos the owner queued offline.
 */

/** The name the photo's mutation is registered and queued under. */
export const PHOTO_MUTATION = 'registerPhoto';

/** The most `registerPhoto` mutations one batch may carry; the other mutations keep `MAX_BATCH`. */
export const MAX_PHOTOS_PER_BATCH = 5;

/**
 * What one `registerPhoto` may take on the server: the S3 read, the re-encode and the S3 writes.
 * An estimate, not a measurement: #23 measures one 2048 px re-encode on the arm64 function, and
 * the cap is tuned from that number.
 */
export const PHOTO_BUDGET_MS = 8_000;
