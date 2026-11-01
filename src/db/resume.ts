/**
 * Waits out a paused Aurora cluster's resume ([PLAT-10]).
 *
 * At a minimum of 0 ACU the cluster pauses after five idle minutes, and the Data API answers the
 * first call after that with `DatabaseResumingException` while the cluster wakes, which takes
 * some seconds. Every call through the database module goes through `retryWhileResuming`, which
 * retries that one error with exponential backoff for up to 30 seconds, logs each wait as one
 * JSON line, and then fails the request with the last error. Any other error fails at once: the
 * AWS SDK's own retries already cover throttling and dropped connections.
 */

/** How long a request may wait for the cluster to resume before it fails. */
export const RESUME_BUDGET_MS = 30_000;

/** The first wait, doubled after each attempt up to `MAX_DELAY_MS`. */
export const FIRST_DELAY_MS = 500;
export const MAX_DELAY_MS = 8_000;

/** One logged wait, a structured line for the request's log (`AGENTS.md` §2). */
export interface ResumeWait {
  readonly level: 'warn';
  readonly event: 'db.resuming';
  readonly msg: string;
  readonly attempt: number;
  readonly waitMs: number;
  readonly waitedMs: number;
}

export interface ResumeOptions {
  /** Where each wait is logged. Defaults to one JSON line on standard output. */
  readonly log?: (entry: ResumeWait) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** The error the Data API answers with while the cluster resumes from a pause. */
export function isResuming(error: unknown): boolean {
  return error instanceof Error && error.name === 'DatabaseResumingException';
}

const defaults = {
  log: (entry: ResumeWait) => console.log(JSON.stringify(entry)),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** Runs `call`, retrying while the cluster resumes, for up to `RESUME_BUDGET_MS` in all. */
export async function retryWhileResuming<T>(call: () => Promise<T>, options: ResumeOptions = {}): Promise<T> {
  const { log, sleep, now } = { ...defaults, ...options };
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const waitedMs = now() - started;
      if (!isResuming(error) || waitedMs >= RESUME_BUDGET_MS) throw error;
      const waitMs = Math.min(FIRST_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS, RESUME_BUDGET_MS - waitedMs);
      log({ level: 'warn', event: 'db.resuming', msg: 'the database is resuming from a pause: waiting', attempt, waitMs, waitedMs });
      await sleep(waitMs);
    }
  }
}

/** The one method of the Data API client the database module calls. */
export interface SendsCommands {
  send(command: never, ...rest: never[]): Promise<unknown>;
}

/** Makes every call `client` sends wait out a resume, and returns the same client. */
export function waitOutResumes<C extends SendsCommands>(client: C, options: ResumeOptions = {}): C {
  const send = client.send.bind(client) as (...args: unknown[]) => Promise<unknown>;
  Object.assign(client, { send: (...args: unknown[]) => retryWhileResuming(() => send(...args), options) });
  return client;
}
