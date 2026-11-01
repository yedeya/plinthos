import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { notFound, redirect } from 'next/navigation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '../../src/app/error';
import GlobalError from '../../src/app/global-error';
import { onRequestError } from '../../src/instrumentation';
import { logger } from '../../src/server/logger';
import { adminRoute, REQUEST_ID_HEADER, reportRequestError } from '../../src/server/request-failure';
import { captureLogger } from './capture';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.restoreAllMocks());

describe('a failed Route Handler', () => {
  const failing = (message: string) => () => {
    throw new Error(message);
  };

  it('[OPS-5] logs one error line with admin.request.failed and a request id, and answers 500 naming the same id', async () => {
    const { log, events } = captureLogger();
    const handler = adminRoute(failing('the handler broke'), log);
    const response = await handler(new Request('https://admin.example.test/admin/sets/42?token=made-up-query-token'), {});

    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event).toMatchObject({ level: 'error', businessEvent: 'admin.request.failed', method: 'GET', path: '/admin/sets/42' });
    expect(event?.requestId).toMatch(UUID);
    expect(event?.err).toMatchObject({ type: 'Error', message: 'the handler broke' });

    expect(response.status).toBe(500);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(event?.requestId);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.requestId).toBe(event?.requestId);
    expect(body.error).toContain(String(event?.requestId));
    expect(body.error).not.toContain('the handler broke');
  });

  it('[OPS-5] [OPS-2] logs neither the query string nor a header', async () => {
    const { log, lines } = captureLogger();
    const request = new Request('https://admin.example.test/admin?token=made-up-query-token', {
      headers: { cookie: 'session=made-up-session-cookie', authorization: 'Bearer made-up-bearer' },
    });
    await adminRoute(failing('broke'), log)(request, {});
    const output = lines.join('');
    for (const value of ['made-up-query-token', 'made-up-session-cookie', 'made-up-bearer']) expect(output).not.toContain(value);
  });

  it('[OPS-5] gives each failed request its own id', async () => {
    const { log, events } = captureLogger();
    const handler = adminRoute(failing('broke'), log);
    await handler(new Request('https://admin.example.test/admin'), {});
    await handler(new Request('https://admin.example.test/admin'), {});
    const [first, second] = events();
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it('[OPS-5] passes an answered request, and Next.js redirects and not-founds, through without logging', async () => {
    const { log, lines } = captureLogger();
    const ok = await adminRoute(() => new Response('fine'), log)(new Request('https://admin.example.test/admin'), {});
    expect(await ok.text()).toBe('fine');
    await expect(adminRoute(() => redirect('/elsewhere'), log)(new Request('https://admin.example.test/admin'), {})).rejects.toThrow();
    await expect(adminRoute(() => notFound(), log)(new Request('https://admin.example.test/admin'), {})).rejects.toThrow();
    expect(lines).toEqual([]);
  });
});

describe('a failure Next.js reports', () => {
  const context = { routerKind: 'App Router', routePath: '/admin/sets/[id]', routeType: 'render', revalidateReason: undefined } as const;

  it('[OPS-5] is logged under the digest, and the error page names that same id', () => {
    const { log, events } = captureLogger();
    const error = Object.assign(new Error('the page broke'), { digest: '2481630742' });
    const requestId = reportRequestError(error, { path: '/admin/sets/42?token=made-up-query-token', method: 'GET' }, context, log);

    expect(requestId).toBe('2481630742');
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      level: 'error',
      businessEvent: 'admin.request.failed',
      requestId: '2481630742',
      path: '/admin/sets/42',
      route: '/admin/sets/[id]',
      routeType: 'render',
    });

    for (const page of [ErrorPage, GlobalError]) {
      const html = renderToStaticMarkup(createElement(page, { error, reset: () => undefined }));
      expect(html).toContain('<code>2481630742</code>');
      expect(html).not.toContain('the page broke');
    }
  });

  it('[OPS-5] gets a fresh id when the error has no digest', () => {
    const { log, events } = captureLogger();
    const requestId = reportRequestError('a thrown string', { path: '/admin', method: 'POST' }, { ...context, routeType: 'route' }, log);
    expect(requestId).toMatch(UUID);
    expect(events()[0]).toMatchObject({ businessEvent: 'admin.request.failed', requestId, err: { message: 'a thrown string' } });
  });

  it('[OPS-5] reaches the one logger through instrumentation.ts', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await onRequestError(Object.assign(new Error('broke'), { digest: '99' }), { path: '/admin', method: 'GET', headers: {} }, context);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatchObject({ businessEvent: 'admin.request.failed', requestId: '99' });
  });

  it('[OPS-5] tells the admin the server logged nothing when the failure was in the browser', () => {
    const html = renderToStaticMarkup(createElement(ErrorPage, { error: new Error('client side'), reset: () => undefined }));
    expect(html).toContain('the server logged nothing');
  });
});
