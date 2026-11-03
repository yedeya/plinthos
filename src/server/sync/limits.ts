/**
 * How much photo work one offline-sync batch may carry ([SYNC-10], #95), and how long its
 * mutations may run on the server ([SYNC-11], #138, at the end). Both halves of the
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

/**
 * How long one batch's mutations may run on the server, measured from the replay's start
 * ([SYNC-11], #138). The replay starts a mutation only when the time the batch has taken plus that
 * mutation's worst case, its registry entry's `budgetMs`, still fits in this; the first that does
 * not is answered `not-attempted`, and so is every one after it, which the device sends again at
 * once in its next batch. The cap's whole batch, `MAX_PHOTOS_PER_BATCH` × `PHOTO_BUDGET_MS`, fits,
 * so it only cuts a batch that carries set lookups, an overrun or a slow database too, or a delete,
 * which keeps `REPUBLISH_BUDGET_MS` of it for the republish after the batch (#187). The rest
 * of the server function's timeout (`SERVER_TIMEOUT` in `infra/admin.ts`) is left for the session
 * check before the replay and the answer after it.
 */
export const BATCH_BUDGET_MS = 40_000;

/**
 * What a mutation that declares no `budgetMs` may take on the server: a handful of Data API
 * calls in its transaction, and an S3 delete or two after it commits. An estimate, like
 * `PHOTO_BUDGET_MS`: the replay measures the time the batch has really taken, so an estimate
 * that is short overruns the budget by at most the one mutation that was started last.
 */
export const MUTATION_BUDGET_MS = 2_000;

/**
 * What the one republish after a batch's deletes may take (#187, [PUB-16]): waiting up to eight
 * seconds for another publish's turn (`LEASE_WAIT`, `src/server/publish/projection.ts`), then the
 * publish itself, about 1,100 photo copies at worst. A batch that carries a delete keeps this much
 * of `BATCH_BUDGET_MS` free for it, so the batch and its republish together still fit the server
 * function's timeout; the mutations it cuts are sent again in the device's next batch.
 */
export const REPUBLISH_BUDGET_MS = 20_000;
