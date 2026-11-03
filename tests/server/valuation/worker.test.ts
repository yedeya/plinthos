import { randomUUID } from 'node:crypto';
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import { describe, expect, it, vi } from 'vitest';
import { lambdaInvoker, selfInvoker } from '../../../src/server/valuation/invoker';
import { createWorker, STEP_BUDGET_MS } from '../../../src/server/valuation/worker';
import { captureLogger } from '../capture';

/**
 * The job's handler and its invoker (brief #226, Issue A, [VAL-9]): the input is a run's id alone,
 * a step works about 13 minutes of the function's 15, and the invocation is asynchronous with the
 * id as its whole payload. No test reaches AWS: the Lambda client is a stand-in, and every name
 * here is made up.
 */

describe('the job’s handler', () => {
  it('[VAL-9] takes a run’s id alone, and runs one step of about 13 minutes for it', async () => {
    const runPriceRefresh = vi.fn(async () => ({ status: 'skipped' as const }));
    const capture = captureLogger();
    const handler = createWorker({ runPriceRefresh }, capture.log);
    const runId = randomUUID();
    expect(await handler({ runId })).toEqual({ status: 'skipped' });
    expect(runPriceRefresh).toHaveBeenCalledWith(runId, { budgetMs: STEP_BUDGET_MS });
    expect(STEP_BUDGET_MS).toBeLessThanOrEqual(13 * 60 * 1000);
    for (const event of [undefined, null, 'run', {}, { runId: 'not-an-id' }, { runId, scope: 'all' }, { runId, all: true }, [runId]]) {
      expect(await handler(event)).toEqual({ status: 'refused' });
    }
    expect(runPriceRefresh).toHaveBeenCalledTimes(1);
    const refused = capture.events().filter((event) => event.businessEvent === 'price.refresh.failed');
    expect(refused).toHaveLength(8);
    for (const event of refused) expect(event).toMatchObject({ reason: 'invalid-input' });
    expect(capture.lines.join('\n')).not.toContain('scope');
  });

  it('[VAL-9] logs a step that failed by its kind alone, and lets it fail', async () => {
    const capture = captureLogger();
    const handler = createWorker({ runPriceRefresh: async () => Promise.reject(new Error('made-up detail arn:aws:lambda:000000000000')) }, capture.log);
    await expect(handler({ runId: randomUUID() })).rejects.toThrow();
    expect(capture.events().find((event) => event.businessEvent === 'price.refresh.failed')).toMatchObject({ reason: 'error', error: 'Error' });
    expect(capture.lines.join('\n')).not.toContain('made-up detail');
  });
});

describe('the job’s invoker', () => {
  it('[VAL-9] invokes the function asynchronously, with the run’s id as the whole payload', async () => {
    const sent: InvokeCommand[] = [];
    const client = { send: vi.fn(async (command: InvokeCommand) => (sent.push(command), { StatusCode: 202 })) } as unknown as LambdaClient;
    const runId = randomUUID();
    await lambdaInvoker('made-up-PriceRefresh', client).invoke(runId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(InvokeCommand);
    expect(sent[0]?.input).toMatchObject({ FunctionName: 'made-up-PriceRefresh', InvocationType: 'Event' });
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.input.Payload as Uint8Array))).toEqual({ runId });
  });

  it('[VAL-9] refuses with no function to invoke, and when Lambda did not queue the event', async () => {
    const client = { send: vi.fn(async () => ({ StatusCode: 500 })) } as unknown as LambdaClient;
    await expect(lambdaInvoker(undefined, client).invoke(randomUUID())).rejects.toThrow(/not linked/);
    await expect(selfInvoker({}).invoke(randomUUID())).rejects.toThrow(/not linked/);
    await expect(lambdaInvoker('made-up-PriceRefresh', client).invoke(randomUUID())).rejects.toThrow(/not queued/);
  });
});
