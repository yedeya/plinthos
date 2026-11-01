/**
 * The deployed login-attempt counter: the `LoginAttempts` DynamoDB table `infra/auth.ts` links
 * to the server function ([AUTH-12]). Made on first use; tests replace this module with an
 * in-memory counter.
 */
import { linkedValue } from '../linked';
import { dynamoCounter, type AttemptCounter } from './rate-limit';

let counter: AttemptCounter | undefined;

export function loginAttemptCounter(): AttemptCounter {
  if (counter === undefined) {
    const table = linkedValue('LoginAttempts', 'name');
    if (table === undefined) throw new Error('The LoginAttempts table is not linked to this function (infra/auth.ts).');
    counter = dynamoCounter(table);
  }
  return counter;
}
