import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '../../src/app/error';
import GlobalError from '../../src/app/global-error';
import { onRequestError } from '../../src/instrumentation';
import { logger } from '../../src/server/logger';
import { failedRequestResponse, logFailedRequest, REQUEST_ID_HEADER, reportRequestError, tagFailure } from '../../src/server/request-failure';
import { captureLogger } from './capture';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.restoreAllMocks());

describe('a failed request', () => {
  it('[OPS-5] logs one error line with admin.request.failed and the request id, and the 500 names the same id', async () => {
    const { log, events } = captureLogger();
    const requestId = logFailedRequest(new Error('the handler broke'), { method: 'GET', path: '/admin/sets/42?token=made-up-query-token', requestId: '7d0c3c39-5b0e-4f53-9a51-6a3f0c0b2f11' }, log);
    const response = failedRequestResponse(requestId);

    expect(events()).toHaveLength(1);
    const [event] = events();
    expect(event).toMatchObject({ level: 'error', businessEvent: 'admin.request.failed', method: 'GET', path: '/admin/sets/42', requestId });
    expect(event?.err).toMatchObject({ type: 'Error', message: 'the handler broke' });

    expect(response.status).toBe(500);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(requestId);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.requestId).toBe(requestId);
    expect(body.error).toContain(requestId);
    expect(body.error).not.toContain('the handler broke');
  });

  it('[OPS-5] gets a fresh id when none is given, a different one each time', () => {
    const { log } = captureLogger();
    const first = logFailedRequest(new Error('broke'), { method: 'GET', path: '/admin' }, log);
    const second = logFailedRequest(new Error('broke'), { method: 'GET', path: '/admin' }, log);
    expect(first).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it('[OPS-5] tags a failure with the request id as its digest, and Next.js’s report of it is not logged again', () => {
    const { log, events } = captureLogger();
    const error = new Error('the page broke');
    logFailedRequest(error, { method: 'GET', path: '/admin', requestId: '5f1b8f3e-2a51-4f3c-8d0e-0a1b2c3d4e5f' }, log);
    const tagged = tagFailure(error, '5f1b8f3e-2a51-4f3c-8d0e-0a1b2c3d4e5f');
    expect(tagged).toBe(error);
    expect((tagged as Error & { digest?: string }).digest).toBe('5f1b8f3e-2a51-4f3c-8d0e-0a1b2c3d4e5f');
    expect(reportRequestError(tagged, { path: '/admin', method: 'GET' }, { routePath: '/admin', routeType: 'render' }, log)).toBe(
      '5f1b8f3e-2a51-4f3c-8d0e-0a1b2c3d4e5f',
    );
    expect(events()).toHaveLength(1);
    expect(tagFailure('a thrown string', 'x')).toBeInstanceOf(Error);
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
