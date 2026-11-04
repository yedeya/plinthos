/**
 * The set index builder's handler (brief #252, Issue A, [CAT-7], [CAT-8]): it runs one build,
 * whatever event it is given, and logs its outcome as one business event. The builds are stand-ins.
 */
import { describe, expect, it } from 'vitest';
import type { BuildOutcome } from '../../../../src/server/catalogue/set-index/build';
import { createSetIndexWorker } from '../../../../src/server/catalogue/set-index/worker';
import { captureLogger } from '../../capture';

const BUILT: BuildOutcome = {
  status: 'built',
  written: true,
  version: 'a'.repeat(64),
  counts: { sets: 4, minifigs: 2, themes: 3 },
  skippedRows: { sets: 1, minifigs: 0, themes: 0 },
  bytes: 1234,
  pruned: true,
};

describe('the set index builder’s handler', () => {
  it('[CAT-7] logs set_index.built with the counts, the skipped rows, the size and the version', async () => {
    const { log, events } = captureLogger();
    const worker = createSetIndexWorker(async () => BUILT, log);
    expect(await worker({})).toEqual(BUILT);
    expect(events()).toEqual([
      expect.objectContaining({
        businessEvent: 'set_index.built',
        level: 'info',
        version: BUILT.version,
        written: true,
        counts: BUILT.counts,
        skippedRows: BUILT.skippedRows,
        bytes: 1234,
      }),
    ]);
  });

  it('[CAT-7] logs set_index.build.failed with the stage and the reason', async () => {
    const { log, events } = captureLogger();
    const failed: BuildOutcome = { status: 'failed', stage: 'download', reason: 'timeout', file: 'sets' };
    expect(await createSetIndexWorker(async () => failed, log)({})).toEqual(failed);
    expect(events()).toEqual([expect.objectContaining({ businessEvent: 'set_index.build.failed', level: 'error', stage: 'download', reason: 'timeout', file: 'sets' })]);
  });

  it('[CAT-8] logs set_index.build.skipped with the last attempt’s time when the guard stops it', async () => {
    const { log, events } = captureLogger();
    const skipped: BuildOutcome = { status: 'skipped', lastAttemptAt: '2026-11-09T08:00:00.000Z' };
    await createSetIndexWorker(async () => skipped, log)({});
    expect(events()).toEqual([expect.objectContaining({ businessEvent: 'set_index.build.skipped', level: 'info', lastAttemptAt: skipped.lastAttemptAt })]);
  });

  it('[CAT-7] logs a build that threw as failed, by the error’s kind alone', async () => {
    const { log, events, lines } = captureLogger();
    const outcome = await createSetIndexWorker(async () => {
      throw new RangeError('made-up message naming made-up-bucket');
    }, log)({});
    expect(outcome).toEqual({ status: 'failed', stage: 'unknown', reason: 'RangeError' });
    expect(events()).toEqual([expect.objectContaining({ businessEvent: 'set_index.build.failed', stage: 'unknown', reason: 'RangeError' })]);
    expect(lines.join('')).not.toContain('made-up-bucket');
  });

  it('[CAT-8] runs the same one build whatever the event holds', async () => {
    const { log } = captureLogger();
    let builds = 0;
    const worker = createSetIndexWorker(async () => {
      builds += 1;
      return BUILT;
    }, log);
    for (const event of [{}, undefined, { url: 'https://rebrickable.com/sets/' }, 'anything']) await worker(event);
    expect(builds).toBe(4);
  });
});
