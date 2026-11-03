import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** What a run refreshes ([VAL-3]): the sets and minifigures, the parts lots, or both. */
export const REFRESH_SCOPES = ['items', 'parts', 'all'] as const;
export type RefreshScope = (typeof REFRESH_SCOPES)[number];

/** A run is running until it ends, as done or as stopped with its reason ([VAL-9]). */
export const RUN_STATES = ['running', 'done', 'stopped'] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Why a run stopped ([VAL-4], [VAL-9], [VAL-10]): the owner asked; BrickLink refused the keys,
 * rate-limited past the retries, or did not answer; the day's BrickLink calls reached the cap; its
 * heartbeat went stale; or the job could not be invoked.
 */
export const STOP_REASONS = ['owner', 'refused-key', 'rate-limited', 'unreachable', 'daily-limit', 'stalled', 'invoke-failed'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * The price refresh's runs (brief #226, Issue A, [VAL-9]): one row per press of **Refresh
 * prices**. The background job reads only its run's row, does what it says, and writes its
 * progress back to it.
 *
 * - **The lease.** At most one row is `running`, which a partial unique index holds, so a second
 *   run can't start while one runs, however the two presses race. A running run whose
 *   `heartbeat_at` is older than 20 minutes is stalled, and is ended as `stopped`/`stalled` by
 *   whoever looks next, which frees the lease.
 * - **The step.** `step_until` is set while one invocation of the job works on the run, until
 *   that invocation's timeout at most, and cleared when it hands the rest to the next one. An
 *   invocation starts working only when no other holds the step, so a continuation delivered
 *   twice works once.
 * - `done`, `failed` and `left` are the run's counts so far; `stop_requested` is the owner's
 *   **Stop**, which the job reads before every request.
 *
 * Every column is private: the admin's own activity, which nothing public needs.
 */
export const priceRefreshRun = pgTable(
  'price_refresh_run',
  {
    // The application makes every key, never the database ([PLAT-13]).
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    scope: text('scope', { enum: REFRESH_SCOPES }).notNull(),
    allPrices: boolean('all_prices').notNull(),
    state: text('state', { enum: RUN_STATES }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    stepUntil: timestamp('step_until', { withTimezone: true, mode: 'date' }),
    done: integer('done').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    left: integer('left').notNull().default(0),
    stopReason: text('stop_reason', { enum: STOP_REASONS }),
    stopRequested: boolean('stop_requested').notNull().default(false),
  },
  (table) => [
    // The lease: one running run at a time ([VAL-9]).
    uniqueIndex('price_refresh_run_one_running_idx').on(table.state).where(sql`${table.state} = 'running'`),
    check('price_refresh_run_scope_check', sql`${table.scope} in ('items', 'parts', 'all')`),
    check('price_refresh_run_state_check', sql`${table.state} in ('running', 'done', 'stopped')`),
    check(
      'price_refresh_run_stop_reason_check',
      sql`${table.stopReason} in ('owner', 'refused-key', 'rate-limited', 'unreachable', 'daily-limit', 'stalled', 'invoke-failed')`,
    ),
    check('price_refresh_run_counts_check', sql`${table.done} >= 0 and ${table.failed} >= 0 and ${table.left} >= 0`),
  ],
);

/**
 * BrickLink calls per UTC day ([VAL-10]): `day` is the day's midnight, UTC, and `calls` how many
 * requests went to BrickLink that day, counted before each is sent. A run stops before a call
 * would take the count past the cap. Private: the admin's own activity.
 */
export const bricklinkCallDay = pgTable(
  'bricklink_call_day',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    day: timestamp('day', { withTimezone: true, mode: 'date' }).notNull(),
    calls: integer('calls').notNull(),
  },
  (table) => [uniqueIndex('bricklink_call_day_day_idx').on(table.day), check('bricklink_call_day_calls_check', sql`${table.calls} >= 0`)],
);
