/**
 * The price refresh's background job: the handler of the Lambda function `infra/prices.ts` defines
 * (brief #226, Issue A, [VAL-9]). The function has no URL; only the admin's server and the
 * function itself may invoke it, asynchronously, with no retry.
 *
 * Its input is `{ runId }` and nothing else, which zod checks: any other field, or an id that is
 * not a UUID, is refused before the database is reached and logged as `price.refresh.failed` with
 * `invalid-input`. The run's row says what to do (`runPriceRefresh`, `./job.ts`), so the input
 * can't widen what a run does. One invocation works for `STEP_BUDGET_MS`, inside the function's
 * 15-minute timeout, and then invokes the function again for the rest.
 */
import { z } from 'zod';
import { logger as defaultLogger, type Logger } from '../logger';
import { linkedPriceProvider } from './bricklink';
import { selfInvoker } from './invoker';
import { createPriceJob, type RunStepResult } from './job';

/** What one invocation may spend: about 13 minutes of the function's 15 ([VAL-9]). */
export const STEP_BUDGET_MS = 13 * 60 * 1000;

/** The job's input: the run's id alone. */
export const WorkerInput = z.strictObject({ runId: z.uuid() });

type Job = Pick<ReturnType<typeof createPriceJob>, 'runPriceRefresh'>;

/** The handler over a job; the deployed one is `handler` below, and the tests pass their own job. */
export function createWorker(job: Job, log: Logger = defaultLogger): (event: unknown) => Promise<RunStepResult | { readonly status: 'refused' }> {
  return async (event) => {
    const input = WorkerInput.safeParse(event);
    if (!input.success) {
      // Never the event itself: it is not ours.
      log.warn({ businessEvent: 'price.refresh.failed', reason: 'invalid-input' }, 'The price refresh job was invoked with input other than a run’s id, and did nothing.');
      return { status: 'refused' };
    }
    try {
      return await job.runPriceRefresh(input.data.runId, { budgetMs: STEP_BUDGET_MS });
    } catch (error) {
      // The run's heartbeat goes stale and it reads as stalled; the error's message is not logged, only its kind.
      log.error({ businessEvent: 'price.refresh.failed', reason: 'error', runId: input.data.runId, error: error instanceof Error ? error.name : 'unknown' }, 'A price refresh step failed.');
      throw error;
    }
  };
}

/** The deployed handler: BrickLink through the linked secrets, and the function's own name for the rest. */
export const handler = createWorker(createPriceJob({ provider: linkedPriceProvider, invoker: () => selfInvoker() }));
