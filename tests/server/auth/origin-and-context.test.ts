import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adminOperation, assertAdmin, issueAdminContext, NotAdminError } from '../../../src/server/auth/admin-context';
import { isSameOrigin } from '../../../src/server/auth/origin';
import { ADMIN_HOST, ADMIN_ORIGIN } from '../../support/auth';

const headers = (values: Record<string, string>) => new Headers(values);

describe('the same-origin check', () => {
  it('[AUTH-7] lets a state-changing request from the admin’s own origin through', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isSameOrigin(method, headers({ origin: ADMIN_ORIGIN, host: ADMIN_HOST })), method).toBe(true);
      expect(isSameOrigin(method, headers({ origin: ADMIN_ORIGIN, 'x-forwarded-host': ADMIN_HOST, host: 'lambda.example.test' }))).toBe(true);
    }
  });

  it('[AUTH-7] refuses one from another origin, with no origin, or that the browser marks cross-site', () => {
    const refused: Record<string, string>[] = [
      { origin: 'https://evil.example.test', host: ADMIN_HOST },
      { origin: 'http://admin.example.test.evil.example.test', host: ADMIN_HOST },
      { host: ADMIN_HOST },
      { origin: 'null', host: ADMIN_HOST },
      { origin: ADMIN_ORIGIN, host: ADMIN_HOST, 'sec-fetch-site': 'cross-site' },
      { origin: ADMIN_ORIGIN, host: ADMIN_HOST, 'sec-fetch-site': 'same-site' },
      { origin: ADMIN_ORIGIN, 'x-forwarded-host': 'evil.example.test', host: ADMIN_HOST },
      { origin: 'not a url', host: ADMIN_HOST },
    ];
    for (const bad of refused) {
      expect(isSameOrigin('POST', headers(bad)), JSON.stringify(bad)).toBe(false);
    }
  });

  it('[AUTH-7] does not stand in the way of a read', () => {
    expect(isSameOrigin('GET', headers({ origin: 'https://evil.example.test' }))).toBe(true);
  });
});

describe('AdminContext', () => {
  it('[AUTH-5] is refused unless the session check issued it, a lookalike included', () => {
    const issued = issueAdminContext({ sessionKey: 'made-up-key', requestId: 'made-up-request' });
    expect(() => assertAdmin(issued)).not.toThrow();
    for (const forged of [undefined, null, {}, { sessionKey: 'made-up-key', requestId: 'made-up-request' }, { ...issued }]) {
      expect(() => assertAdmin(forged), JSON.stringify(forged)).toThrow(NotAdminError);
    }
  });

  it('[AUTH-5] makes every service function check the admin before it validates its input or runs', async () => {
    let ran = 0;
    const operation = adminOperation(z.object({ name: z.string() }), async (_admin, input) => {
      ran++;
      return input.name;
    });
    const admin = issueAdminContext({ sessionKey: 'made-up-key', requestId: 'made-up-request' });
    expect(await operation(admin, { name: 'made-up' })).toBe('made-up');
    const forged = { sessionKey: 'made-up-key', requestId: 'made-up-request' } as unknown as typeof admin;
    await expect(operation(forged, { name: 'made-up' })).rejects.toThrow(NotAdminError);
    await expect(operation(forged, { name: 42 } as unknown as { name: string })).rejects.toThrow(NotAdminError);
    await expect(operation(admin, { name: 42 } as unknown as { name: string })).rejects.toThrow(z.ZodError);
    expect(ran).toBe(1);
  });
});
