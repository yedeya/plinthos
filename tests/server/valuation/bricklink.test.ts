/**
 * The BrickLink client, against a stand-in `fetch` and made-up items and credentials only: no
 * test reaches BrickLink, and no key here is real. The OAuth signing is checked against two
 * published worked examples first: RFC 5849 §3.4.1.1's signature base string, and the HMAC-SHA1
 * signature of Twitter's "Creating a signature" guide, whose credentials are the guide's own
 * published sample values. Time is a fake clock that the injected `sleep` advances, so the
 * limiter, the backoff and the budget are checked to the millisecond.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE,
  bricklinkProvider,
  DEFAULT_CURRENCY,
  hmacSha1Signature,
  linkedPriceProvider,
  MIN_REQUEST_INTERVAL_MS,
  oauthAuthorization,
  oauthEncode,
  priceCurrency,
  PriceUnavailable,
  REQUEST_TIMEOUT_MS,
  resetBrickLinkRateLimit,
  signatureBaseString,
  type BrickLinkCredentials,
  type PriceUnavailableReason,
} from '../../../src/server/valuation/bricklink';
import { captureSharedLogger } from '../capture';

/** Made-up credentials, distinctive enough to find in any line one leaked into. */
const CANARY: BrickLinkCredentials = {
  consumerKey: 'canary-consumer-key-6b1e0d7a93f2',
  consumerSecret: 'canary-consumer-secret-4c8a2f19e0d5',
  tokenValue: 'canary-token-value-9e3b7c05a1d8',
  tokenSecret: 'canary-token-secret-2d6f8a4b0c7e',
};
const NONCE = 'madeupnonce0123456789abcdef';
const CLOCK_START = 1_900_000_000_000;

/** A made-up price guide answer, in BrickLink's documented shape. */
function guide(overrides: Record<string, unknown> = {}) {
  return {
    meta: { description: 'OK', message: 'OK', code: 200 },
    data: {
      item: { no: '90001-1', type: 'SET' },
      new_or_used: 'N',
      currency_code: 'EUR',
      min_price: '80.0000',
      max_price: '240.5000',
      avg_price: '123.4567',
      qty_avg_price: '120.0000',
      unit_quantity: 42,
      total_quantity: 57,
      price_detail: [],
      ...overrides,
    },
  };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const refusal = (code: number, message: string, init: ResponseInit = {}) => json({ meta: { description: `${message} detail`, message, code }, data: {} }, { status: code, ...init });

interface Call {
  url: string;
  at: number;
  headers: Headers;
}

/** A fake clock, and a stand-in fetch whose answers a test scripts per call. */
function harness(route: (url: string, call: number) => Response | 'hang' | Promise<Response>, options: { currency?: string; nonce?: () => string } = {}) {
  let clock = CLOCK_START;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, at: clock, headers: new Headers(init?.headers) });
    const answer = route(url, calls.length);
    if (answer === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return answer;
  });
  const provider = bricklinkProvider(CANARY, {
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    nonce: options.nonce ?? (() => NONCE),
    currency: options.currency ?? 'EUR',
  });
  return { provider, calls, sleeps, now: () => clock };
}

async function reasonOf(promise: Promise<unknown>): Promise<PriceUnavailableReason> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(PriceUnavailable);
  return (error as PriceUnavailable).reason;
}

/** The `Authorization` header's fields, decoded. */
function oauthFields(header: string | null): Record<string, string> {
  expect(header).toMatch(/^OAuth /);
  return Object.fromEntries([...(header ?? '').slice('OAuth '.length).matchAll(/([a-z_]+)="([^"]*)"/g)].map(([, name, value]) => [name, decodeURIComponent(value ?? '')]));
}

let captured: ReturnType<typeof captureSharedLogger>;
beforeEach(() => {
  resetBrickLinkRateLimit();
  captured = captureSharedLogger();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const failures = () => captured.events().filter((event) => event.businessEvent === 'price.lookup.failed');

describe('the OAuth 1.0a signature', () => {
  it('[VAL-1] builds RFC 5849 §3.4.1.1’s signature base string, leaving realm and the signature out', () => {
    const url = 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b';
    const query = [...new URL(url).searchParams.entries()];
    const body: [string, string][] = [
      ['c2', ''],
      ['a3', '2 q'],
    ];
    const oauth: [string, string][] = [
      ['realm', 'Example'],
      ['oauth_consumer_key', '9djdj82h48djs9d2'],
      ['oauth_token', 'kkk9d7dh3k39sjv7'],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '137131201'],
      ['oauth_nonce', '7d8f3e4a'],
      ['oauth_signature', 'djosJKDKJSD8743243%2Fjdk33klY%3D'],
    ];
    expect(signatureBaseString('POST', url, [...query, ...body, ...oauth])).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7',
    );
    // §3.4.1.2: the scheme and host in lower case, without a default port or the query.
    expect(signatureBaseString('get', 'HTTP://EXAMPLE.COM:80/r%20v/X?id=123', [])).toBe('GET&http%3A%2F%2Fexample.com%2Fr%2520v%2FX&');
    expect(oauthEncode("Ladies + Gentlemen!*'()~")).toBe('Ladies%20%2B%20Gentlemen%21%2A%27%28%29~');
  });

  it('[VAL-1] gives the HMAC-SHA1 signature of Twitter’s published worked example', () => {
    const url = 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true';
    const params: [string, string][] = [
      ['include_entities', 'true'],
      ['status', 'Hello Ladies + Gentlemen, a signed OAuth request!'],
      ['oauth_consumer_key', 'xvz1evFS4wEEPTGEFPHBog'],
      ['oauth_nonce', 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg'],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '1318622958'],
      ['oauth_token', '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb'],
      ['oauth_version', '1.0'],
    ];
    const base = signatureBaseString('POST', url, params);
    expect(base).toBe(
      'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
    );
    expect(hmacSha1Signature(base, 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE')).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });

  it('[VAL-1] signs a BrickLink price guide GET over its query and the oauth_* parameters, in BrickLink’s header form', () => {
    const url = `${API_BASE}/items/set/90001-1/price?guide_type=sold&new_or_used=N&currency_code=EUR`;
    const header = oauthAuthorization(url, CANARY, NONCE, 1_900_000_000);
    const expectedBase = [
      'GET',
      'https%3A%2F%2Fapi.bricklink.com%2Fapi%2Fstore%2Fv1%2Fitems%2Fset%2F90001-1%2Fprice',
      [
        'currency_code%3DEUR',
        'guide_type%3Dsold',
        'new_or_used%3DN',
        `oauth_consumer_key%3D${CANARY.consumerKey}`,
        `oauth_nonce%3D${NONCE}`,
        'oauth_signature_method%3DHMAC-SHA1',
        'oauth_timestamp%3D1900000000',
        `oauth_token%3D${CANARY.tokenValue}`,
        'oauth_version%3D1.0',
      ].join('%26'),
    ].join('&');
    const expectedSignature = createHmac('sha1', `${CANARY.consumerSecret}&${CANARY.tokenSecret}`).update(expectedBase).digest('base64');
    expect(header).toBe(
      `OAuth realm="", oauth_consumer_key="${CANARY.consumerKey}", oauth_token="${CANARY.tokenValue}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1900000000", oauth_nonce="${NONCE}", oauth_version="1.0", oauth_signature="${oauthEncode(expectedSignature)}"`,
    );
    // The secrets only key the signature: neither is in the header.
    expect(header).not.toContain(CANARY.consumerSecret);
    expect(header).not.toContain(CANARY.tokenSecret);
  });
});

describe('the BrickLink client', () => {
  it('[VAL-1] [VAL-2] asks the six-month sold guide in the deployment’s currency, signed in the header, never in the URL', async () => {
    const { provider, calls } = harness(() => json(guide()));
    await expect(provider.priceGuide('SET', ' 90001-1 ', 'N', { budgetMs: 30_000 })).resolves.toEqual({
      itemType: 'SET',
      itemNo: '90001-1',
      newOrUsed: 'N',
      average: 123.4567,
      sampleSize: 42,
      currency: 'EUR',
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE}/items/set/90001-1/price`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ guide_type: 'sold', new_or_used: 'N', currency_code: 'EUR' });
    const header = calls[0]?.headers.get('authorization') ?? null;
    const fields = oauthFields(header);
    expect(fields).toMatchObject({ realm: '', oauth_consumer_key: CANARY.consumerKey, oauth_token: CANARY.tokenValue, oauth_nonce: NONCE, oauth_timestamp: String(CLOCK_START / 1000), oauth_signature_method: 'HMAC-SHA1', oauth_version: '1.0' });
    expect(header).toBe(oauthAuthorization(calls[0]?.url ?? '', CANARY, NONCE, CLOCK_START / 1000));
    for (const value of Object.values(CANARY)) expect(calls[0]?.url).not.toContain(value);
    expect(calls[0]?.url).not.toContain('oauth');
  });

  it('[VAL-2] asks a used minifigure by its reference number, in another currency, and answers no average for an item with no sale', async () => {
    const { provider, calls } = harness(() => json(guide({ item: { no: 'mf0001', type: 'MINIFIG' }, new_or_used: 'U', currency_code: 'USD', avg_price: '0.0000', unit_quantity: 0, total_quantity: 0 })), { currency: 'USD' });
    await expect(provider.priceGuide('MINIFIG', 'mf0001', 'U', { budgetMs: 30_000 })).resolves.toEqual({
      itemType: 'MINIFIG',
      itemNo: 'mf0001',
      newOrUsed: 'U',
      average: null,
      sampleSize: 0,
      currency: 'USD',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/store/v1/items/minifig/mf0001/price');
    expect(Object.fromEntries(url.searchParams)).toEqual({ guide_type: 'sold', new_or_used: 'U', currency_code: 'USD' });
  });

  it('[VAL-1] uses a fresh nonce and the current time for every request', async () => {
    let n = 0;
    const { provider, calls } = harness(() => json(guide()), { nonce: () => `nonce${(n += 1)}` });
    await provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 });
    await provider.priceGuide('SET', '90001-1', 'U', { budgetMs: 30_000 });
    const [first, second] = calls.map((call) => oauthFields(call.headers.get('authorization')));
    expect([first?.oauth_nonce, second?.oauth_nonce]).toEqual(['nonce1', 'nonce2']);
    expect(Number(second?.oauth_timestamp) - Number(first?.oauth_timestamp)).toBe(MIN_REQUEST_INTERVAL_MS / 1000);

    // The default nonce is random.
    resetBrickLinkRateLimit();
    const seen: string[] = [];
    const real = bricklinkProvider(CANARY, {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(oauthFields(new Headers(init?.headers).get('authorization')).oauth_nonce ?? '');
        return json(guide());
      }) as typeof fetch,
      sleep: async () => undefined,
      currency: 'EUR',
    });
    await real.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 });
    await real.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 });
    expect(seen[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('[VAL-2] answers null for an item BrickLink does not know, a 404, and logs no failure', async () => {
    const { provider, calls } = harness(() => refusal(404, 'RESOURCE_NOT_FOUND'));
    await expect(provider.priceGuide('SET', '99999-9', 'N', { budgetMs: 30_000 })).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    // The same refusal inside a 200's body.
    resetBrickLinkRateLimit();
    const inBody = harness(() => json({ meta: { description: 'not found', message: 'RESOURCE_NOT_FOUND', code: '404' }, data: {} }));
    await expect(inBody.provider.priceGuide('MINIFIG', 'mf9999', 'U', { budgetMs: 30_000 })).resolves.toBeNull();
    expect(failures()).toEqual([]);
  });

  it('[VAL-1] a 401 or a 403 is refused-key, without a retry, in the status line or in meta.code', async () => {
    const scripts = [
      () => refusal(401, 'BAD_OAUTH_REQUEST'),
      () => refusal(403, 'PERMISSION_DENIED'),
      () => json({ meta: { description: 'bad nonce', message: 'BAD_OAUTH_REQUEST', code: 401 }, data: {} }),
    ];
    for (const script of scripts) {
      resetBrickLinkRateLimit();
      const { provider, calls } = harness(script);
      expect(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 }))).toBe('refused-key');
      expect(calls).toHaveLength(1);
    }
    expect(failures().map((event) => [event.reason, event.code])).toEqual([
      ['refused-key', 401],
      ['refused-key', 403],
      ['refused-key', 401],
    ]);
  });

  it('[VAL-1] starts at most one request a second, across every provider in the instance', async () => {
    const first = harness(() => json(guide()));
    await first.provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 });
    await first.provider.priceGuide('SET', '90001-1', 'U', { budgetMs: 30_000 });
    await first.provider.priceGuide('SET', '90002-1', 'N', { budgetMs: 30_000 });
    const starts = first.calls.map(({ at }) => at);
    expect(starts).toEqual([CLOCK_START, CLOCK_START + MIN_REQUEST_INTERVAL_MS, CLOCK_START + 2 * MIN_REQUEST_INTERVAL_MS]);

    // A second provider in the same instance queues on the same limiter.
    const other = harness(() => json(guide()));
    await other.provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 });
    expect(other.sleeps).toEqual([3 * MIN_REQUEST_INTERVAL_MS]);
  });

  it('[VAL-1] fails as a timeout, without a request, when the next free slot would come after the budget', async () => {
    const { provider, calls } = harness(() => json(guide()));
    await provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000 });
    expect(await reasonOf(provider.priceGuide('SET', '90002-1', 'N', { budgetMs: 500 }))).toBe('timeout');
    expect(calls).toHaveLength(1);
  });

  it('[VAL-1] aborts a request after at most 10 seconds and fails as a timeout, without a retry', async () => {
    vi.useFakeTimers();
    const { provider, calls } = harness(() => 'hang');
    const outcome = reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 }));
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('timeout');
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(calls).toHaveLength(1);
  });

  it('[VAL-1] times a request out at the end of a budget shorter than 10 seconds', async () => {
    vi.useFakeTimers();
    const { provider } = harness(() => 'hang');
    const outcome = reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 2500 }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(await outcome).toBe('timeout');
  });

  it('[VAL-1] retries a 429 or a 5xx at most twice, with exponential backoff, then fails with the reason', async () => {
    const limited = harness(() => refusal(429, 'TOO_MANY_REQUESTS'));
    expect(await reasonOf(limited.provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 }))).toBe('rate-limited');
    expect(limited.calls).toHaveLength(3);
    expect(limited.sleeps).toEqual([1000, 2000]);

    resetBrickLinkRateLimit();
    const down = harness(() => refusal(500, 'INTERNAL_SERVER_ERROR'));
    expect(await reasonOf(down.provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 }))).toBe('upstream');
    expect(down.calls).toHaveLength(3);

    resetBrickLinkRateLimit();
    const recovers = harness((_url, call) => (call === 1 ? new Response('bad gateway', { status: 502 }) : json(guide())));
    await expect(recovers.provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 })).resolves.toMatchObject({ average: 123.4567 });
    expect(recovers.calls).toHaveLength(2);
  });

  it('[VAL-1] does not retry a 400', async () => {
    const { provider, calls } = harness(() => refusal(400, 'PARAMETER_MISSING_OR_INVALID'));
    expect(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 }))).toBe('upstream');
    expect(calls).toHaveLength(1);
  });

  it('[VAL-1] waits at least what Retry-After asks before a retry', async () => {
    const { provider, calls } = harness((_url, call) => (call === 1 ? refusal(429, 'TOO_MANY_REQUESTS', { headers: { 'Retry-After': '7' } }) : json(guide())));
    await provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 });
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBe(7000);
  });

  it('[VAL-1] never retries past the budget: a Retry-After beyond it fails at once, without waiting', async () => {
    const { provider, calls, sleeps } = harness(() => refusal(429, 'TOO_MANY_REQUESTS', { headers: { 'Retry-After': '30' } }));
    expect(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 20_000 }))).toBe('rate-limited');
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);

    resetBrickLinkRateLimit();
    // Backoff of 1 s, then 2 s: the second retry would end past a 2.5-second budget.
    const short = harness(() => new Response('', { status: 503 }));
    expect(await reasonOf(short.provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 2500 }))).toBe('upstream');
    expect(short.calls).toHaveLength(2);
    expect(short.now() - CLOCK_START).toBeLessThan(2500);
  });

  it('[VAL-1] an answer it can not read, or a network failure, is upstream', async () => {
    for (const script of [() => json({ meta: { code: 200 }, data: { unexpected: true } }), () => new Response('<html>maintenance</html>', { status: 200 }), () => Promise.reject(new TypeError('fetch failed'))]) {
      resetBrickLinkRateLimit();
      const { provider } = harness(script);
      expect(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 }))).toBe('upstream');
    }
  });

  it('[VAL-1] sends nothing for a call whose caller already gave up, and logs it as no failure', async () => {
    const { provider, calls } = harness(() => json(guide()));
    const controller = new AbortController();
    controller.abort();
    expect(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 30_000, signal: controller.signal }))).toBe('aborted');
    expect(calls).toEqual([]);
    expect(failures()).toEqual([]);
  });

  it('[VAL-1] logs price.lookup.failed with the reason, and never a secret, the signature, the header or a URL', async () => {
    const signatures: string[] = [];
    const scripts: (() => Response | Promise<Response>)[] = [
      () => refusal(401, `BAD_OAUTH_REQUEST for ${CANARY.consumerKey}`),
      () => refusal(429, 'TOO_MANY_REQUESTS'),
      () => new Response(`upstream echoed ${CANARY.consumerSecret} ${CANARY.tokenSecret} ${CANARY.tokenValue}`, { status: 500 }),
      () => Promise.reject(new TypeError(`${API_BASE}/items/set/90001-1/price?oauth_token=${CANARY.tokenValue}&oauth_signature=x`)),
    ];
    const reasons: PriceUnavailableReason[] = [];
    for (const script of scripts) {
      resetBrickLinkRateLimit();
      const { provider, calls } = harness(script);
      reasons.push(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 })));
      for (const call of calls) signatures.push(oauthFields(call.headers.get('authorization')).oauth_signature ?? '');
    }
    expect(reasons).toEqual(['refused-key', 'rate-limited', 'upstream', 'upstream']);
    expect(failures().map((event) => event.reason)).toEqual(reasons);
    for (const event of failures()) expect(event).toMatchObject({ level: 'warn', itemType: 'SET', itemNo: '90001-1', newOrUsed: 'N' });
    const output = captured.lines.join('');
    for (const value of Object.values(CANARY)) expect(output).not.toContain(value);
    expect(signatures.length).toBeGreaterThan(0);
    for (const signature of signatures) {
      expect(output).not.toContain(signature);
      expect(output).not.toContain(oauthEncode(signature));
    }
    expect(output).not.toMatch(/OAuth|oauth_|bricklink\.com|https?:\/\//);
    expect(output).not.toContain('BAD_OAUTH_REQUEST');
  });

  it('[VAL-1] never puts a secret in the message of the error a caller receives', async () => {
    const { provider } = harness(() => refusal(401, `BAD_OAUTH_REQUEST ${CANARY.consumerSecret}`));
    const error = await provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 60_000 }).catch((thrown: unknown) => thrown as Error);
    for (const value of Object.values(CANARY)) {
      expect(String((error as Error).message)).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
    }
  });
});

describe('the BrickLink credentials and currency', () => {
  it('[VAL-1] are read from the server function’s links only: with none linked, every call is refused-key and nothing is fetched', async () => {
    const fetchImpl = vi.fn();
    const provider = linkedPriceProvider({ fetch: fetchImpl as unknown as typeof fetch });
    expect(await reasonOf(provider.priceGuide('SET', '90001-1', 'N', { budgetMs: 1000 }))).toBe('refused-key');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(failures().map((event) => event.reason)).toEqual(['refused-key']);
  });

  it('[VAL-2] asks in PLINTHOS_CURRENCY, EUR by default', () => {
    expect(DEFAULT_CURRENCY).toBe('EUR');
    expect(priceCurrency({})).toBe('EUR');
    expect(priceCurrency({ PLINTHOS_CURRENCY: ' GBP ' })).toBe('GBP');
    expect(priceCurrency({ PLINTHOS_CURRENCY: 'pounds' })).toBe('EUR');
  });
});
