import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GUARD } from '../../src/server/auth/admin';
import { issueAdminContext, type AdminContext } from '../../src/server/auth/admin-context';
import { SESSION_COOKIE } from '../../src/server/auth/cookie';
import { DEFAULT_PARTS_MAX_BYTES } from '../../src/server/parts/config';
import { IMPORT_KEY } from '../../src/server/photos/keys';
import { memoryBucket } from '../server/photos/fakes';

// The session check is stood in for, and the photo bucket is an in-memory one: the parts presign route
// must never reach the database ([AUTH-6]), and CI has no AWS.
const state = vi.hoisted(() => ({ admin: null as AdminContext | null, databaseCalls: 0, bucket: undefined as ReturnType<typeof memoryBucket> | undefined }));
vi.mock('../../src/server/database', () => ({
  database: () => {
    state.databaseCalls += 1;
    throw new Error('the database was called');
  },
}));
vi.mock('../../src/server/auth/sessions', () => ({
  authenticate: async (cookie: string | undefined) => (cookie === 'made-up-valid-session' ? state.admin : null),
}));
vi.mock('../../src/server/photos/aws', () => ({
  photosBucket: () => 'made-up-photo-bucket',
  s3PhotoStorage: () => {
    if (state.bucket === undefined) throw new Error('the test set no bucket');
    return state.bucket.storage;
  },
}));

const { POST } = await import('../../src/app/admin/api/parts/uploads/route');

/**
 * `POST /admin/api/parts/uploads`, the parts file's presign route ([PARTS-2], #161): a presigned
 * upload into the private imports prefix, issued only to a valid session, for a random key the
 * server makes, capped at `PLINTHOS_PARTS_MAX_BYTES`.
 */

const ORIGIN = 'https://admin.example.test';
const context = { params: Promise.resolve({}) };
const sameOrigin = { origin: ORIGIN, host: 'admin.example.test', 'sec-fetch-site': 'same-origin' };

function request(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/admin/api/parts/uploads`, { method: 'POST', headers: { ...sameOrigin, ...headers } });
}

afterEach(() => {
  state.admin = null;
  state.databaseCalls = 0;
  state.bucket = undefined;
});

describe('POST /admin/api/parts/uploads', () => {
  it('[PARTS-2] is an admin route, built with the admin check', () => {
    expect((POST as unknown as Record<symbol, unknown>)[ADMIN_GUARD]).toBe('route');
  });

  it('[PARTS-2] presigns nothing for an anonymous, forged or cross-origin request', async () => {
    state.bucket = memoryBucket();
    for (const headers of [{}, { cookie: `${SESSION_COOKIE}=made-up-forged` }, { 'x-middleware-subrequest': 'middleware' }] as Record<string, string>[]) {
      expect((await POST(request(headers), context)).status).toBe(401);
    }
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    const crossOrigin = await POST(request({ origin: 'https://evil.example.test', cookie: `${SESSION_COOKIE}=made-up-valid-session` }), context);
    expect(crossOrigin.status).toBe(403);
    expect(state.bucket.presigned).toEqual([]);
    expect(state.databaseCalls).toBe(0);
  });

  it('[PARTS-2] answers a valid session with a fresh imports key, its presigned form and the configured cap, never cached, without the database', async () => {
    state.bucket = memoryBucket();
    state.admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
    const first = await POST(request({ cookie: `${SESSION_COOKIE}=made-up-valid-session` }), context);
    const second = await POST(request({ cookie: `${SESSION_COOKIE}=made-up-valid-session` }), context);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = (await first.json()) as { key: string; url: string; fields: Record<string, string>; maxBytes: number };
    const other = (await second.json()) as { key: string };
    expect(body.key).toMatch(IMPORT_KEY);
    expect(other.key).not.toBe(body.key);
    expect(body.fields.key).toBe(body.key);
    expect(body.maxBytes).toBe(DEFAULT_PARTS_MAX_BYTES);
    expect(state.bucket.presigned[0]?.conditions.maxBytes).toBe(DEFAULT_PARTS_MAX_BYTES);
    expect(state.bucket.presigned.map(({ key }) => key)).toEqual([body.key, other.key]);
    expect(state.databaseCalls).toBe(0);
  });
});
