/**
 * The set index builder's handler: the Lambda function `infra/set-index.ts` defines, which a
 * schedule invokes once a week and the owner may invoke by hand (`docs/deploy.md`), with no retry
 * (brief #252, Issue A).
 *
 * It runs one `buildSetIndex` and logs what it answers as one business event: `set_index.built`,
 * `set_index.build.failed` or `set_index.build.skipped` (`docs/observability.md`, [CAT-7]). The
 * event it is invoked with is never read, so no input can change what a build fetches or writes.
 * It answers the outcome, which a run by hand prints.
 */
import { logger as defaultLogger, type Logger } from '../../logger';
import { buildSetIndex, type BuildOutcome } from './build';
import { linkedSetIndexStore, WRITER_LINK } from './s3';

/** The handler over a build; the deployed one is `handler` below, and the tests pass their own build. */
export function createSetIndexWorker(build: () => Promise<BuildOutcome>, log: Logger = defaultLogger): (event: unknown) => Promise<BuildOutcome> {
  return async () => {
    let outcome: BuildOutcome;
    try {
      outcome = await build();
    } catch (error) {
      // `buildSetIndex` answers every failure itself; this is the backstop. Never the error's message.
      outcome = { status: 'failed', stage: 'unknown', reason: error instanceof Error ? error.name : 'unknown' };
    }
    switch (outcome.status) {
      case 'built': {
        const { version, written, counts, skippedRows, bytes, pruned } = outcome;
        log.info({ businessEvent: 'set_index.built', version, written, counts, skippedRows, bytes, pruned }, written ? 'Built and wrote the set index.' : 'Built the set index; it is unchanged, so nothing new was written.');
        break;
      }
      case 'skipped':
        log.info({ businessEvent: 'set_index.build.skipped', lastAttemptAt: outcome.lastAttemptAt }, 'Skipped the set index build: the last attempt was less than 24 hours ago.');
        break;
      case 'failed':
        log.error({ businessEvent: 'set_index.build.failed', stage: outcome.stage, reason: outcome.reason, file: outcome.file }, 'The set index build failed; the previous index stays in place.');
        break;
    }
    return outcome;
  };
}

/** The deployed handler: the builder's own link to the index's prefix, and Rebrickable's files. */
export const handler = createSetIndexWorker(() => buildSetIndex({ store: linkedSetIndexStore(WRITER_LINK) }));
