/**
 * How the price refresh's background job is started ([VAL-9]): an asynchronous Lambda invocation
 * (`InvocationType: 'Event'`) of the job's function, `infra/prices.ts`, whose payload is the run's
 * id alone. The admin's server invokes it by the name `infra/stack.ts` links to it as
 * `PriceRefresh`; the job invokes itself for the rest of a run by its own name, which Lambda puts
 * in its environment. The invocation answers once Lambda has queued the event; the job runs
 * after. The tests use a fake `PriceJobInvoker`.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { linkedValue } from '../linked';

/** Starts the job for one run. It resolves once the invocation is queued, and throws when it is not. */
export interface PriceJobInvoker {
  invoke(runId: string): Promise<void>;
}

/** The name `infra/stack.ts` links the job's function to the admin's server under. */
export const PRICE_JOB_LINK = 'PriceRefresh';

/** The longest one invocation request may take: queueing an event is quick. */
export const INVOKE_TIMEOUT_MS = 10_000;

let shared: LambdaClient | undefined;

/** Invokes the named function with `{ runId }`, asynchronously. */
export function lambdaInvoker(functionName: string | undefined, client?: LambdaClient): PriceJobInvoker {
  return {
    async invoke(runId) {
      if (functionName === undefined || functionName.trim() === '') throw new Error('The price refresh job has no function to invoke: it is not linked.');
      const lambda = client ?? (shared ??= new LambdaClient({ maxAttempts: 3, requestHandler: { requestTimeout: INVOKE_TIMEOUT_MS, connectionTimeout: 5_000 } }));
      const answer = await lambda.send(
        new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: new TextEncoder().encode(JSON.stringify({ runId })) }),
      );
      // An event invocation that Lambda queued answers 202.
      if (answer.StatusCode !== 202) throw new Error(`The price refresh job was not queued: Lambda answered ${String(answer.StatusCode)}.`);
    },
  };
}

/** The admin's server's invoker: the job's function, by the name linked to it. */
export function linkedJobInvoker(): PriceJobInvoker {
  return lambdaInvoker(linkedValue(PRICE_JOB_LINK, 'name'));
}

/** The job's own invoker, for the rest of a run: its own function, by the name Lambda gives it. */
export function selfInvoker(env: Readonly<Record<string, string | undefined>> = process.env): PriceJobInvoker {
  return lambdaInvoker(env.AWS_LAMBDA_FUNCTION_NAME);
}
