import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GUARD } from '../../src/server/auth/admin';
import { issueAdminContext, type AdminContext } from '../../src/server/auth/admin-context';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';
import type { CatalogueSet } from '../../src/server/catalogue/rebrickable';

// The session check and the set lookup are stood in for: an anonymous request must reach neither
// the database nor the catalogue ([AUTH-6], [CAT-1]).
const state = vi.hoisted(() => ({
  admin: null as AdminContext | null,
  databaseCalls: 0,
  searches: [] as string[],
  answer: { status: 'ok', sets: [] as CatalogueSet[] } as { status: 'ok'; sets: CatalogueSet[] } | { status: 'unavailable' },
}));
vi.mock('../../src/server/database', () => ({
  database: () => {
    state.databaseCalls += 1;
    throw new Error('the database was called');
  },
}));
vi.mock('../../src/server/auth/sessions', () => ({
  authenticate: async (cookie: string | undefined) => (cookie === 'made-up-valid-session' ? state.admin : null),
}));
vi.mock('../../src/server/catalogue/sets', () => ({
  searchSets: async (_admin: AdminContext, query: string) => {
    state.searches.push(query);
    return state.answer;
  },
}));

const { GET } = await import('../../src/app/admin/api/sets/search/route');

const ORIGIN = 'https://admin.example.test';
const context = { params: Promise.resolve({}) };

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/admin/api/sets/search?q=${encodeURIComponent(query)}`, { headers: { host: 'admin.example.test', ...headers } });
}

afterEach(() => {
  state.admin = null;
  state.databaseCalls = 0;
  state.searches = [];
  state.answer = { status: 'ok', sets: [] };
});

describe('GET /admin/api/sets/search', () => {
  it('[CAT-1] is an admin route, built with the admin check', () => {
    expect((GET as unknown as Record<symbol, unknown>)[ADMIN_GUARD]).toBe('route');
  });

  it('[CAT-1] refuses an anonymous or forged request without touching the database or the catalogue', async () => {
    for (const headers of [{}, { cookie: `${SESSION_COOKIE}=made-up-forged` }, { 'x-middleware-subrequest': 'middleware' }] as Record<string, string>[]) {
      expect((await GET(request('windmill', headers), context)).status).toBe(401);
    }
    expect(state.searches).toEqual([]);
    expect(state.databaseCalls).toBe(0);
  });

  it('[CAT-1] [CAT-5] answers the search as JSON, never cached, including unavailable', async () => {
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    const cookie = { cookie: `${SESSION_COOKIE}=made-up-valid-session` };
    const ok = await GET(request('windmill', cookie), context);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toEqual({ status: 'ok', sets: [] });
    state.answer = { status: 'unavailable' };
    const down = await GET(request('windmill', cookie), context);
    expect(down.status).toBe(200);
    expect(await down.json()).toEqual({ status: 'unavailable' });
    expect(state.searches).toEqual(['windmill', 'windmill']);
  });
});
