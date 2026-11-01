import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GUARD } from '../../src/server/auth/admin';
import { issueAdminContext, type AdminContext } from '../../src/server/auth/admin-context';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';

// An anonymous request must never reach the database ([AUTH-6]); a signed-in one is given a
// context by the session check, which is stood in for here.
const state = vi.hoisted(() => ({ admin: null as AdminContext | null, databaseCalls: 0 }));
vi.mock('../../src/server/database', () => ({
  database: () => {
    state.databaseCalls += 1;
    throw new Error('the database was called');
  },
}));
vi.mock('../../src/server/auth/sessions', () => ({
  authenticate: async (cookie: string | undefined) => (cookie === 'made-up-valid-session' ? state.admin : null),
}));
const replayMutations = vi.hoisted(() => vi.fn(async (...args: [unknown, unknown]) => ({ outcomes: [], calledWith: args.length })));
vi.mock('../../src/server/sync/replay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/server/sync/replay')>()),
  replayMutations,
}));

const { POST } = await import('../../src/app/admin/api/sync/route');

const ORIGIN = 'https://admin.example.test';
const context = { params: Promise.resolve({}) };

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/admin/api/sync`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'admin.example.test', 'sec-fetch-site': 'same-origin', ...headers },
  });
}

const signedIn = { cookie: `${SESSION_COOKIE}=made-up-valid-session` };
const batch = JSON.stringify({ mutations: [{ id: randomUUID(), name: 'test.spy', input: {} }] });

afterEach(() => {
  state.admin = null;
  state.databaseCalls = 0;
  replayMutations.mockClear();
});

describe('POST /admin/api/sync', () => {
  it('[SYNC-1] is an admin route, built with the admin check', () => {
    expect((POST as unknown as Record<symbol, unknown>)[ADMIN_GUARD]).toBe('route');
  });

  it('[SYNC-1] refuses an anonymous request before the body is read or the database is called', async () => {
    for (const headers of [{} as Record<string, string>, { cookie: `${SESSION_COOKIE}=made-up-forged` }, { 'x-middleware-subrequest': 'middleware' }]) {
      const response = await POST(request(batch, headers), context);
      expect(response.status).toBe(401);
    }
    expect(replayMutations).not.toHaveBeenCalled();
    expect(state.databaseCalls).toBe(0);
  });

  it('[SYNC-1] refuses a request from another origin', async () => {
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    const response = await POST(request(batch, { ...signedIn, origin: 'https://elsewhere.example.test', 'sec-fetch-site': 'cross-site' }), context);
    expect(response.status).toBe(403);
    expect(replayMutations).not.toHaveBeenCalled();
  });

  it('[SYNC-1] hands the batch to the replay with the session’s own AdminContext', async () => {
    const admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    state.admin = admin;
    const response = await POST(request(batch, signedIn), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ outcomes: [], calledWith: 2 });
    expect(replayMutations).toHaveBeenCalledTimes(1);
    expect(replayMutations.mock.calls[0]?.[0]).toBe(admin);
    expect(replayMutations.mock.calls[0]?.[1]).toEqual(JSON.parse(batch));
  });

  it('[SYNC-4] answers a body that is not JSON, or not a batch, with 400 and replays nothing', async () => {
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    for (const body of ['not json', '{}', JSON.stringify({ mutations: [] }), JSON.stringify({ mutations: 'x' })]) {
      const response = await POST(request(body, signedIn), context);
      expect(response.status, body).toBe(400);
      expect(((await response.json()) as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(replayMutations).not.toHaveBeenCalled();
  });
});
