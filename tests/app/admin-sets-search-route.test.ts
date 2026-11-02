import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GUARD } from '../../src/server/auth/admin';
import { issueAdminContext, type AdminContext } from '../../src/server/auth/admin-context';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';
import { fakeCatalogue, type FakeCatalogue } from '../server/catalogue/fakes';

// The session check is stood in for, and so is the catalogue: an anonymous search must reach
// neither the database nor Rebrickable ([CAT-1], [AUTH-6]).
const state = vi.hoisted(() => ({ admin: null as AdminContext | null, databaseCalls: 0, catalogue: undefined as FakeCatalogue | undefined }));
vi.mock('../../src/server/database', () => ({
  database: () => {
    state.databaseCalls += 1;
    throw new Error('the database was called');
  },
}));
vi.mock('../../src/server/auth/sessions', () => ({
  authenticate: async (cookie: string | undefined) => (cookie === 'made-up-valid-session' ? state.admin : null),
}));
vi.mock('../../src/server/catalogue/rebrickable', async (original) => ({
  ...(await original<typeof import('../../src/server/catalogue/rebrickable')>()),
  linkedCatalogueProvider: () => {
    if (state.catalogue === undefined) throw new Error('the test set no catalogue');
    return state.catalogue.provider;
  },
}));

const { GET } = await import('../../src/app/admin/api/sets/search/route');

/** `GET /admin/api/sets/search?q=`, the set search ([CAT-1], [CAT-5]). */

const ORIGIN = 'https://admin.example.test';
const context = { params: Promise.resolve({}) };

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/admin/api/sets/search?q=${encodeURIComponent(query)}`, { headers: { host: 'admin.example.test', ...headers } });
}

const signedIn = { cookie: `${SESSION_COOKIE}=made-up-valid-session` };

afterEach(() => {
  state.admin = null;
  state.databaseCalls = 0;
  state.catalogue = undefined;
});

describe('GET /admin/api/sets/search', () => {
  it('[CAT-1] is an admin route, built with the admin check', () => {
    expect((GET as unknown as Record<symbol, unknown>)[ADMIN_GUARD]).toBe('route');
  });

  it('[CAT-1] refuses an anonymous or forged request without touching the database or Rebrickable', async () => {
    state.catalogue = fakeCatalogue();
    for (const headers of [{}, { cookie: `${SESSION_COOKIE}=made-up-forged` }, { 'x-middleware-subrequest': 'middleware' }] as Record<string, string>[]) {
      expect((await GET(request('lighthouse', headers), context)).status).toBe(401);
    }
    expect(state.catalogue.calls).toEqual([]);
    expect(state.databaseCalls).toBe(0);
  });

  it('[CAT-1] answers a signed-in query shorter than two characters with no sets, never cached, calling nothing', async () => {
    state.catalogue = fakeCatalogue();
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    const response = await GET(request('a', signedIn), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', sets: [] });
    expect(state.catalogue.calls).toEqual([]);
    expect(state.databaseCalls).toBe(0);
  });

  it('[CAT-5] answers unavailable with a 200, not an error page, when Rebrickable fails', async () => {
    state.catalogue = fakeCatalogue();
    state.catalogue.failWith = 'refused-key';
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    const response = await GET(request('lighthouse', signedIn), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(state.catalogue.calls).toEqual(['search lighthouse']);
  });
});
