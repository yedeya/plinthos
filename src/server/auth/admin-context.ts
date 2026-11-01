/**
 * `AdminContext`: the proof that a request comes from the signed-in admin, which every service
 * function that changes data takes as its first argument and checks itself ([AUTH-5]).
 *
 * Only the session check makes one (`./sessions.ts`, through the wrappers in `./admin.ts`), from
 * a session the database holds and whose lifetimes have not passed. An object of the same shape
 * made anywhere else is refused: `assertAdmin` knows every context it issued, so a forged or
 * copied one fails even when its fields are right.
 */
import type { z } from 'zod';

declare const brand: unique symbol;

export interface AdminContext {
  /** The session row's key (`admin_session.id`), never the session id the cookie carries. */
  readonly sessionKey: string;
  /** The request's own id, which `admin.request.failed` logs and the error page names ([OPS-5]). */
  readonly requestId: string;
  readonly [brand]: true;
}

/** Thrown when a service function is handed anything but an `AdminContext` the session check issued. */
export class NotAdminError extends Error {
  override name = 'NotAdminError';
}

const issued = new WeakSet<object>();

/** Issues a context for a session the check has just accepted. Only `./sessions.ts` calls it. */
export function issueAdminContext(fields: { sessionKey: string; requestId: string }): AdminContext {
  const context = Object.freeze({ sessionKey: fields.sessionKey, requestId: fields.requestId }) as unknown as AdminContext;
  issued.add(context);
  return context;
}

/** Refuses, before anything else runs, a value the session check did not issue ([AUTH-5]). */
export function assertAdmin(value: unknown): asserts value is AdminContext {
  if (typeof value !== 'object' || value === null || !issued.has(value)) {
    throw new NotAdminError('This operation needs the signed-in admin: no valid AdminContext was given.');
  }
}

/**
 * Defines a data-changing service function (`AGENTS.md` §4): the admin check, then the zod
 * validation of its input, then the operation. The admin UI, the offline-sync endpoint and any
 * later tool call the result, so each check happens once, here.
 *
 *     export const publishCatalogue = adminOperation(PublishInput, async (admin, input) => { … });
 */
export function adminOperation<Schema extends z.ZodType, Result>(
  schema: Schema,
  operation: (admin: AdminContext, input: z.output<Schema>) => Promise<Result>,
): (admin: AdminContext, input: z.input<Schema>) => Promise<Result> {
  return async (admin, input) => {
    assertAdmin(admin);
    return operation(admin, schema.parse(input));
  };
}
