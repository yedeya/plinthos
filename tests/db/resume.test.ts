import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectDatabase } from '../../src/db/client';
import {
  FIRST_DELAY_MS,
  MAX_DELAY_MS,
  RESUME_BUDGET_MS,
  RESUME_MESSAGE,
  retryWhileResuming,
  type ResumeWait,
} from '../../src/db/resume';
import { captureSharedLogger } from '../server/capture';

afterEach(() => vi.restoreAllMocks());

/** The error the Data API answers with while a paused cluster resumes. */
function resuming(): Error {
  return Object.assign(new Error('The database is resuming after being auto-paused.'), { name: 'DatabaseResumingException' });
}

/** A clock that only moves when the code under test sleeps, and a log that keeps every wait. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  const waits: ResumeWait[] = [];
  return {
    sleeps,
    waits,
    elapsed: () => now,
    options: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      log: (entry: ResumeWait) => waits.push(entry),
    },
  };
}

/** A call that fails with `errors`, in order, and then answers `value`. */
function failing<T>(errors: Error[], value: T) {
  let calls = 0;
  return {
    calls: () => calls,
    call: async () => {
      const error = errors[calls++];
      if (error !== undefined) throw error;
      return value;
    },
  };
}

describe('waiting out a resume', () => {
  it('[PLAT-10] retries while the cluster resumes, with exponential backoff, and logs each wait', async () => {
    const time = fakeTime();
    const call = failing([resuming(), resuming(), resuming()], 'answered');
    await expect(retryWhileResuming(call.call, time.options)).resolves.toBe('answered');
    expect(call.calls()).toBe(4);
    expect(time.sleeps).toEqual([FIRST_DELAY_MS, FIRST_DELAY_MS * 2, FIRST_DELAY_MS * 4]);
    expect(time.waits).toHaveLength(3);
    expect(time.waits[0]).toEqual({
      event: 'db.resuming',
      attempt: 1,
      waitMs: FIRST_DELAY_MS,
      waitedMs: 0,
    });
    expect(time.waits.map(({ waitedMs }) => waitedMs)).toEqual([0, FIRST_DELAY_MS, FIRST_DELAY_MS * 3]);
  });

  it('[PLAT-10] gives up after 30 seconds of waiting, and fails the request with the resume error', async () => {
    const time = fakeTime();
    const error = resuming();
    let calls = 0;
    const always = async () => {
      calls++;
      throw error;
    };
    await expect(retryWhileResuming(always, time.options)).rejects.toBe(error);
    expect(RESUME_BUDGET_MS).toBe(30_000);
    expect(time.elapsed()).toBe(RESUME_BUDGET_MS);
    expect(Math.max(...time.sleeps)).toBeLessThanOrEqual(MAX_DELAY_MS);
    // One call more than waits: the last one, at 30 seconds, is the one that fails.
    expect(calls).toBe(time.sleeps.length + 1);
  });

  it('[PLAT-10] fails at once on any other error, without waiting', async () => {
    const time = fakeTime();
    const other = Object.assign(new Error('syntax error at or near "selec"'), { name: 'BadRequestException' });
    await expect(retryWhileResuming(failing([other], 'never').call, time.options)).rejects.toBe(other);
    expect(time.sleeps).toEqual([]);
    expect(time.waits).toEqual([]);
  });

  it('[PLAT-10] [PLAT-9] every Data API call the database module sends waits out a resume', async () => {
    const time = fakeTime();
    const client = new RDSDataClient({ region: 'eu-central-1', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } });
    const sent: unknown[] = [];
    const answers = [resuming()];
    Object.assign(client, {
      send: async (command: unknown) => {
        sent.push(command);
        const error = answers.shift();
        if (error !== undefined) throw error;
        return { columnMetadata: [{ name: 'answer' }], records: [[{ longValue: 42 }]] };
      },
    });
    const db = connectDatabase(
      { clusterArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:fake', secretArn: 'arn:aws:secretsmanager:eu-central-1:000000000000:secret:fake', database: 'plinthos' },
      { ...time.options, client },
    );
    const result = await db.execute(sql`select 42 as answer`);
    expect(result.rows).toEqual([{ answer: 42 }]);
    expect(sent).toHaveLength(2);
    for (const command of sent) {
      expect(command).toBeInstanceOf(ExecuteStatementCommand);
      expect((command as ExecuteStatementCommand).input).toMatchObject({
        resourceArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:fake',
        database: 'plinthos',
      });
    }
    expect(time.waits).toHaveLength(1);
  });

  it('[PLAT-10] [OPS-1] logs each wait, by default, as a warning through the one pino logger', async () => {
    const { events } = captureSharedLogger();
    const { now, sleep } = fakeTime().options;
    const call = failing([resuming(), resuming()], 'answered');
    await expect(retryWhileResuming(call.call, { now, sleep })).resolves.toBe('answered');
    expect(events()).toHaveLength(2);
    expect(events()[0]).toMatchObject({ level: 'warn', msg: RESUME_MESSAGE, event: 'db.resuming', attempt: 1, waitMs: FIRST_DELAY_MS, waitedMs: 0 });
    expect(events()[1]).toMatchObject({
      level: 'warn',
      msg: RESUME_MESSAGE,
      event: 'db.resuming',
      attempt: 2,
      waitMs: FIRST_DELAY_MS * 2,
      waitedMs: FIRST_DELAY_MS,
    });
  });

  it('[PLAT-10] [OPS-1] logs the waits of the database module deployed code uses through the one pino logger', async () => {
    const { events } = captureSharedLogger();
    const { now, sleep } = fakeTime().options;
    const client = new RDSDataClient({ region: 'eu-central-1', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } });
    const answers = [resuming()];
    Object.assign(client, {
      send: async () => {
        const error = answers.shift();
        if (error !== undefined) throw error;
        return { columnMetadata: [{ name: 'answer' }], records: [[{ longValue: 42 }]] };
      },
    });
    const db = connectDatabase(
      { clusterArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:fake', secretArn: 'arn:aws:secretsmanager:eu-central-1:000000000000:secret:fake', database: 'plinthos' },
      { now, sleep, client },
    );
    await db.execute(sql`select 42 as answer`);
    expect(events()).toEqual([
      expect.objectContaining({ level: 'warn', msg: RESUME_MESSAGE, event: 'db.resuming', attempt: 1, waitMs: FIRST_DELAY_MS, waitedMs: 0 }),
    ]);
  });

  it('[PLAT-9] refuses a resource that is not the deployed cluster’s Data API ARNs', () => {
    expect(() => connectDatabase({ clusterArn: 'localhost:5432', secretArn: 'arn:x', database: 'plinthos' })).toThrow();
    expect(() => connectDatabase({ clusterArn: 'arn:x', secretArn: 'arn:y', database: '' })).toThrow();
  });
});
