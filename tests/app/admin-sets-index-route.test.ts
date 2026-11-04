import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GUARD } from '../../src/server/auth/admin';
import { issueAdminContext, type AdminContext } from '../../src/server/auth/admin-context';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';

// The session check and the index's read are stood in for: an anonymous request must reach
// neither the database nor the bucket ([AUTH-6], [CAT-9]).
const state = vi.hoisted(() => ({
  admin: null as AdminContext | null,
  databaseCalls: 0,
  reads: [] as { ifNoneMatch: string | null | undefined }[],
  answer: { status: 'missing' } as { status: 'missing' } | { status: 'not-modified'; version: string } | { status: 'ok'; version: string; body: Uint8Array },
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
vi.mock('../../src/server/catalogue/set-index/file', () => ({
  setIndexFile: async (_admin: AdminContext, input: { ifNoneMatch?: string | null }) => {
    state.reads.push({ ifNoneMatch: input.ifNoneMatch });
    return state.answer;
  },
}));

const { GET } = await import('../../src/app/admin/api/sets/index/route');

const ORIGIN = 'https://admin.example.test';
const context = { params: Promise.resolve({}) };
const VERSION = 'b'.repeat(64);
const SIGNED_IN = { cookie: `${SESSION_COOKIE}=made-up-valid-session` };

function request(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/admin/api/sets/index`, { headers: { host: 'admin.example.test', ...headers } });
}

function signIn() {
  state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
}

afterEach(() => {
  state.admin = null;
  state.databaseCalls = 0;
  state.reads = [];
  state.answer = { status: 'missing' };
});

describe('GET /admin/api/sets/index', () => {
  it('[CAT-9] is an admin route, built with the admin check', () => {
    expect((GET as unknown as Record<symbol, unknown>)[ADMIN_GUARD]).toBe('route');
  });

  it('[CAT-9] refuses an anonymous or forged request without touching the database or the index', async () => {
    for (const headers of [{}, { cookie: `${SESSION_COOKIE}=made-up-forged` }, { 'x-middleware-subrequest': 'middleware' }] as Record<string, string>[]) {
      expect((await GET(request(headers), context)).status).toBe(401);
    }
    expect(state.reads).toEqual([]);
    expect(state.databaseCalls).toBe(0);
  });

  it('[CAT-9] answers the index gzipped, with its version as the ETag and no-store', async () => {
    signIn();
    const body = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    state.answer = { status: 'ok', version: VERSION, body };
    const answer = await GET(request(SIGNED_IN), context);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/gzip');
    expect(answer.headers.get('etag')).toBe(`"${VERSION}"`);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    // The bytes as stored: no layer is asked to decompress them on the way.
    expect(answer.headers.get('content-encoding')).toBeNull();
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(body);
    expect(state.reads).toEqual([{ ifNoneMatch: null }]);
  });

  it('[CAT-9] answers 304 to an If-None-Match that names the current version', async () => {
    signIn();
    state.answer = { status: 'not-modified', version: VERSION };
    const answer = await GET(request({ ...SIGNED_IN, 'if-none-match': `"${VERSION}"` }), context);
    expect(answer.status).toBe(304);
    expect(answer.headers.get('etag')).toBe(`"${VERSION}"`);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.text()).toBe('');
    expect(state.reads).toEqual([{ ifNoneMatch: `"${VERSION}"` }]);
  });

  it('[CAT-9] answers 404 while no index has been built', async () => {
    signIn();
    const answer = await GET(request(SIGNED_IN), context);
    expect(answer.status).toBe(404);
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });
});
