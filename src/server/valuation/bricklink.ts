/**
 * The one BrickLink client ([VAL-1]): every request to BrickLink's store API v1 goes through here.
 * It asks one thing, the price guide of an item: a set or a minifigure ([VAL-2]), or a parts
 * lot's item by its type and, for a part, its colour ([VAL-8]).
 *
 * - **The request.** `GET /items/{type}/{no}/price?guide_type=sold&new_or_used=N|U&currency_code=…`,
 *   with `color_id=…` for a `PART` alone (BrickLink's "Get Price Guide", re-read on 2026-11-03:
 *   `color_id` is an optional integer, and the path's type is one of BrickLink's type names):
 *   the "Last 6 Months Sales" statistics, worldwide (no `country_code` and no `region`), in the
 *   deployment's currency (`PLINTHOS_CURRENCY`, default `EUR`), and without VAT, BrickLink's
 *   default (`vat` unset). The answer's `avg_price` is the average, `unit_quantity` the number of
 *   sales it averages over. An item with no sale in six months has no average.
 * - **The signature.** OAuth 1.0a, HMAC-SHA1, with `node:crypto` and no dependency. BrickLink uses
 *   OAuth 1.0's signing process (oauth.net/core/1.0 §9, the same as RFC 5849 §3.4) with no token
 *   exchange: the consumer key and secret and the access token and its secret are issued once, for
 *   one registered IP address, here `0.0.0.0` (`docs/deploy.md`, step 4). The signature base
 *   string covers the `oauth_*` parameters and the query's, never `realm`. The parameters travel
 *   in the `Authorization: OAuth realm="", …` header, never in the URL, so no URL this module
 *   builds is signed. Each request has its own nonce and timestamp.
 * - **A timeout.** Each request is aborted after at most `REQUEST_TIMEOUT_MS`, or sooner when the
 *   caller's budget ends first.
 * - **One request a second.** The limiter is module-level, so every provider in one server
 *   instance shares it. BrickLink's API documentation states neither a per-second limit nor a
 *   daily quota; one request a second keeps an on-demand refresh of one collection, a few hundred
 *   requests, well inside the 5,000 calls a day BrickLink is widely reported to allow. The
 *   background job counts its calls per UTC day and stops below that ([VAL-10], `./job.ts`).
 * - **At most two retries**, on a 429 or a 5xx only, with exponential backoff that waits at least
 *   what `Retry-After` asks. A wait that would end past the caller's `budgetMs` is not started.
 * - **Errors.** BrickLink answers an error with its HTTP status and a JSON body whose `meta.code`
 *   repeats it. An answer that says 200 in its status line but carries another `meta.code` is
 *   read by that code. A 404 (`RESOURCE_NOT_FOUND`) is an item BrickLink does not know, which is
 *   null, not a failure. A 401 (`BAD_OAUTH_REQUEST`) or a 403 (`PERMISSION_DENIED`, such as a
 *   request from an address the token is not registered for) is `refused-key`.
 * - **Nothing secret is logged.** A failure is logged once as `price.lookup.failed` with its
 *   reason and the HTTP code, never a credential, the signature, the header, a URL or BrickLink's
 *   message. The logger also scrubs all four linked secrets' values from every line
 *   (`src/server/logger.ts`).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PartQuoteItemType } from '../../db/schema/part-price-quote';
import { linkedValue } from '../linked';
import { logger } from '../logger';

/** BrickLink's item types, as its API names them ([VAL-2], [VAL-8]). */
export type PriceItemType = PartQuoteItemType;

/**
 * The BrickLink type of a parts file's one-letter item type ([VAL-8]); a letter not here has no
 * BrickLink price.
 */
export const BRICKLINK_TYPE_BY_LETTER: Readonly<Record<string, PriceItemType>> = {
  P: 'PART',
  M: 'MINIFIG',
  S: 'SET',
  B: 'BOOK',
  G: 'GEAR',
  C: 'CATALOG',
  I: 'INSTRUCTION',
  O: 'ORIGINAL_BOX',
};

/** The BrickLink type of a lot's letter, or null for one BrickLink doesn't price ([VAL-8]). */
export function bricklinkTypeOf(letter: string): PriceItemType | null {
  return Object.hasOwn(BRICKLINK_TYPE_BY_LETTER, letter.trim().toUpperCase()) ? (BRICKLINK_TYPE_BY_LETTER[letter.trim().toUpperCase()] ?? null) : null;
}
/** `N` for a sealed set, `U` for a used one ([VAL-2]). */
export type NewOrUsed = 'N' | 'U';

/** One item's price guide: the six-month sold average, or null when nothing sold ([VAL-2]). */
export interface PriceGuide {
  itemType: PriceItemType;
  itemNo: string;
  newOrUsed: NewOrUsed;
  /** The average sale price in `currency`, or null when the item had no sale in six months. */
  average: number | null;
  /** The number of sales the average is over. */
  sampleSize: number;
  /** The ISO 4217 code BrickLink answered in. */
  currency: string;
}

/**
 * What a call may spend, and the signal that says its caller gave up: an aborted call reserves
 * no request slot, sends no request, and stops waiting for its slot.
 */
export interface PriceCallOptions {
  budgetMs: number;
  signal?: AbortSignal;
  /** The colour of a `PART`, as BrickLink's colour id ([VAL-8]); never sent for any other type. */
  colorId?: number;
  /**
   * Asked before each request leaves, every retry included: the background job counts it against
   * the day's BrickLink calls, and false refuses the request with `daily-limit` ([VAL-10]).
   */
  admit?: () => Promise<boolean>;
}

export interface PriceProvider {
  /** The item's price guide, or null when BrickLink does not know the item. */
  priceGuide(itemType: PriceItemType, itemNo: string, newOrUsed: NewOrUsed, opts: PriceCallOptions): Promise<PriceGuide | null>;
}

/**
 * `aborted`: the caller gave up first, so nothing failed; it is never logged as a failure.
 * `daily-limit`: the caller's `admit` refused the request, which was never sent ([VAL-10]).
 */
export type PriceUnavailableReason = 'timeout' | 'rate-limited' | 'refused-key' | 'upstream' | 'aborted' | 'daily-limit';

/** BrickLink could not answer. The message names the reason only. */
export class PriceUnavailable extends Error {
  override name = 'PriceUnavailable';
  constructor(readonly reason: PriceUnavailableReason) {
    super(`The price guide is unavailable: ${reason}.`);
  }
}

/** The four values BrickLink issues for one API consumer and one registered IP address. */
export interface BrickLinkCredentials {
  consumerKey: string;
  consumerSecret: string;
  tokenValue: string;
  tokenSecret: string;
}

export const API_BASE = 'https://api.bricklink.com/api/store/v1';
/** The longest one request may take ([VAL-1]). */
export const REQUEST_TIMEOUT_MS = 10_000;
/** The shortest gap between two requests' starts, from one server instance ([VAL-1]). */
export const MIN_REQUEST_INTERVAL_MS = 1000;
/** Retries after the first attempt, on a 429 or a 5xx ([VAL-1]). */
export const MAX_RETRIES = 2;
/** The first retry's backoff; each next one doubles it. */
export const BASE_BACKOFF_MS = 1000;

/** The deployment's currency ([VAL-2]): `infra/config.ts` checks it and hands it to the function. */
export const CURRENCY_ENV = 'PLINTHOS_CURRENCY';
export const DEFAULT_CURRENCY = 'EUR';
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The deployed currency, from the server function's environment, or `EUR`. */
export function priceCurrency(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env[CURRENCY_ENV]?.trim();
  return value !== undefined && CURRENCY_CODE.test(value) ? value : DEFAULT_CURRENCY;
}

/** The SST secrets the credentials come from, in `BrickLinkCredentials`' order. */
export const BRICKLINK_SECRETS = ['BrickLinkConsumerKey', 'BrickLinkConsumerSecret', 'BrickLinkTokenValue', 'BrickLinkTokenSecret'] as const;

export interface PriceProviderOptions {
  fetch?: typeof fetch;
  /** Milliseconds, on any clock that `sleep` advances. The OAuth timestamp is read from it too. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Each request's OAuth nonce. Defaults to 16 random bytes in hex. */
  nonce?: () => string;
  /** The ISO 4217 code prices are asked in. Defaults to `PLINTHOS_CURRENCY`. */
  currency?: string;
}

// BrickLink's fixed-point numbers arrive as strings, such as "162.3401"; a number is accepted too.
const fixedPoint = z.union([z.string().regex(/^-?\d+(\.\d+)?$/), z.number()]).transform(Number);
const metaSchema = z.object({ code: z.union([z.number(), z.string()]).optional() }).passthrough();
const priceGuideSchema = z.object({
  meta: metaSchema.optional(),
  data: z.object({
    currency_code: z.string().min(1),
    avg_price: fixedPoint,
    unit_quantity: z.number().int().nonnegative(),
  }),
});

/** The module-level limiter: one per server instance, shared by every provider in it ([VAL-1]). */
const limiter: { lastStart: number | undefined } = { lastStart: undefined };

/** Forgets the last request's time. Tests only: each starts with a fresh clock. */
export function resetBrickLinkRateLimit(): void {
  limiter.lastStart = undefined;
}

/** RFC 3986 percent-encoding, as OAuth 1.0 requires: every character but `A-Za-z0-9-._~`. */
export function oauthEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The signature base string (RFC 5849 §3.4.1): the method, the base URL without its query, and
 * every parameter, the query's and the `oauth_*` ones but never `realm` or `oauth_signature`,
 * each name and value encoded, sorted by name then value, and joined.
 */
export function signatureBaseString(method: string, url: string, params: readonly (readonly [string, string])[]): string {
  const parsed = new URL(url);
  // `URL` lowercases the scheme and the host and drops a default port, as §3.4.1.2 asks.
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const normalized = params
    .filter(([name]) => name !== 'realm' && name !== 'oauth_signature')
    .map(([name, value]) => [oauthEncode(name), oauthEncode(value)] as const)
    .sort(([an, av], [bn, bv]) => (an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return [method.toUpperCase(), oauthEncode(baseUrl), oauthEncode(normalized)].join('&');
}

/** HMAC-SHA1 over the base string, keyed by both secrets (RFC 5849 §3.4.2), in base64. */
export function hmacSha1Signature(baseString: string, consumerSecret: string, tokenSecret: string): string {
  return createHmac('sha1', `${oauthEncode(consumerSecret)}&${oauthEncode(tokenSecret)}`).update(baseString).digest('base64');
}

/**
 * The `Authorization` header of one signed GET: the query's parameters are read from `url`, and
 * the header carries the `oauth_*` ones with the signature, in the form BrickLink documents.
 */
export function oauthAuthorization(url: string, credentials: BrickLinkCredentials, nonce: string, timestampSeconds: number): string {
  const oauth: [string, string][] = [
    ['oauth_consumer_key', credentials.consumerKey],
    ['oauth_token', credentials.tokenValue],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', String(timestampSeconds)],
    ['oauth_nonce', nonce],
    ['oauth_version', '1.0'],
  ];
  const query = [...new URL(url).searchParams.entries()];
  const signature = hmacSha1Signature(signatureBaseString('GET', url, [...query, ...oauth]), credentials.consumerSecret, credentials.tokenSecret);
  const fields = [['realm', ''], ...oauth, ['oauth_signature', signature]].map(([name, value]) => `${name}="${oauthEncode(value ?? '')}"`);
  return `OAuth ${fields.join(', ')}`;
}

/** Whether the caller has given up; a function, so a check after an `await` reads it afresh. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type Answer = { status: 'ok'; body: unknown } | { status: 'not-found' };
/** A refusal, by its code: the HTTP status, or `meta.code` when the status line said 200. */
type Attempt = { code: number; body: unknown; retryAfter: string | null };

/** The provider over BrickLink's store API v1, signed with `credentials`. */
export function bricklinkProvider(credentials: BrickLinkCredentials, opts: PriceProviderOptions = {}): PriceProvider {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nonce = opts.nonce ?? (() => randomBytes(16).toString('hex'));
  const currency = opts.currency ?? priceCurrency();

  /**
   * Reserves this instance's next free slot and waits for it, or fails at once when it would come
   * at or past the deadline. The reservation is made before the first `await`, and a call that
   * fails here reserves nothing.
   */
  async function takeSlot(deadline: number, signal: AbortSignal | undefined): Promise<void> {
    if (isAborted(signal)) throw new PriceUnavailable('aborted');
    const current = now();
    const before = limiter.lastStart;
    const start = before === undefined ? current : Math.max(current, before + MIN_REQUEST_INTERVAL_MS);
    if (start >= deadline) throw new PriceUnavailable('timeout');
    limiter.lastStart = start;
    if (start > current) {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted');
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const ended = await Promise.race([sleep(start - current).then(() => 'slept' as const), aborted]);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      if (ended === 'aborted') {
        // Give the slot back when nobody has queued behind it.
        if (limiter.lastStart === start) limiter.lastStart = before;
        throw new PriceUnavailable('aborted');
      }
    }
    if (isAborted(signal)) throw new PriceUnavailable('aborted');
  }

  /** One signed attempt, aborted after the timeout, at the deadline or when the caller gives up. */
  async function attempt(url: string, deadline: number, signal: AbortSignal | undefined, admit: PriceCallOptions['admit']): Promise<Attempt> {
    await takeSlot(deadline, signal);
    if (admit !== undefined && !(await admit())) throw new PriceUnavailable('daily-limit');
    if (isAborted(signal)) throw new PriceUnavailable('aborted');
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - now());
    if (timeoutMs <= 0) throw new PriceUnavailable('timeout');
    // Signed at the slot's start, so the timestamp is the moment the request leaves.
    const authorization = oauthAuthorization(url, credentials, nonce(), Math.floor(now() / 1000));
    const controller = new AbortController();
    const giveUp = () => controller.abort();
    signal?.addEventListener('abort', giveUp, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PriceUnavailable('timeout'));
      }, timeoutMs);
    });
    const request = (async (): Promise<Attempt> => {
      const response = await fetchImpl(url, {
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: controller.signal,
      });
      const retryAfter = response.headers.get('retry-after');
      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        // A 2xx that is not JSON is unreadable; a refusal's body is not needed.
        if (response.ok) throw new PriceUnavailable('upstream');
      }
      return { code: response.ok ? (metaCode(body) ?? response.status) : response.status, body, retryAfter };
    })();
    // A late rejection of the losing promise is not an unhandled one.
    request.catch(() => undefined);
    try {
      return await Promise.race([request, timedOut]);
    } catch (error) {
      if (error instanceof PriceUnavailable) throw error;
      if (isAborted(signal)) throw new PriceUnavailable('aborted');
      if (controller.signal.aborted) throw new PriceUnavailable('timeout');
      // A network failure. Its message is not kept: it may hold the URL.
      throw new PriceUnavailable('upstream');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
    }
  }

  /** A signed GET with the retries, inside the deadline. A 404 is `not-found`; any other refusal throws. */
  async function get(url: string, deadline: number, signal: AbortSignal | undefined, admit: PriceCallOptions['admit'], failure: { code?: number }): Promise<Answer> {
    for (let retry = 0; ; retry += 1) {
      const { code, body, retryAfter } = await attempt(url, deadline, signal, admit);
      failure.code = code;
      if (code >= 200 && code < 300) return { status: 'ok', body };
      if (code === 404) return { status: 'not-found' };
      if (code === 401 || code === 403) throw new PriceUnavailable('refused-key');
      const retryable = code === 429 || code >= 500;
      const reason = code === 429 ? 'rate-limited' : 'upstream';
      if (!retryable || retry >= MAX_RETRIES) throw new PriceUnavailable(reason);
      const backoff = BASE_BACKOFF_MS * 2 ** retry;
      const delay = Math.max(backoff, retryAfterMs(retryAfter, now()) ?? 0);
      // Never wait into, or past, the end of the caller's budget.
      if (now() + delay >= deadline) throw new PriceUnavailable(reason);
      if (isAborted(signal)) throw new PriceUnavailable('aborted');
      await sleep(delay);
    }
  }

  return {
    async priceGuide(itemType, itemNo, newOrUsed, { budgetMs, signal, colorId, admit }) {
      const deadline = now() + budgetMs;
      const failure: { code?: number } = {};
      const number = itemNo.trim();
      try {
        const query = new URLSearchParams({ guide_type: 'sold', new_or_used: newOrUsed, currency_code: currency });
        // A colour belongs to a part alone ([VAL-8]).
        if (itemType === 'PART' && colorId !== undefined) query.set('color_id', String(colorId));
        const url = `${API_BASE}/items/${itemType.toLowerCase()}/${encodeURIComponent(number)}/price?${query.toString()}`;
        const answer = await get(url, deadline, signal, admit, failure);
        if (answer.status === 'not-found') return null;
        const parsed = priceGuideSchema.safeParse(answer.body);
        if (!parsed.success || !Number.isFinite(parsed.data.data.avg_price)) throw new PriceUnavailable('upstream');
        const { avg_price: average, unit_quantity: sampleSize, currency_code } = parsed.data.data;
        return { itemType, itemNo: number, newOrUsed, average: sampleSize > 0 ? average : null, sampleSize, currency: currency_code };
      } catch (error) {
        const reason: PriceUnavailableReason = error instanceof PriceUnavailable ? error.reason : 'upstream';
        // A call its caller gave up on, or refused itself, did not fail.
        if (reason === 'aborted' || reason === 'daily-limit') throw error;
        logger.warn(
          { businessEvent: 'price.lookup.failed', itemType, itemNo: number, newOrUsed, reason, ...(failure.code === undefined ? {} : { code: failure.code }) },
          'a BrickLink price guide lookup failed',
        );
        throw error instanceof PriceUnavailable ? error : new PriceUnavailable('upstream');
      }
    },
  };
}

/**
 * The provider over the server function's four linked BrickLink secrets ([VAL-1]), in the
 * deployment's currency. Without all four, every call is `refused-key` and nothing is fetched.
 */
export function linkedPriceProvider(opts: PriceProviderOptions = {}): PriceProvider {
  const [consumerKey, consumerSecret, tokenValue, tokenSecret] = BRICKLINK_SECRETS.map((name) => linkedValue(name)?.trim() ?? '');
  if (consumerKey && consumerSecret && tokenValue && tokenSecret) {
    return bricklinkProvider({ consumerKey, consumerSecret, tokenValue, tokenSecret }, opts);
  }
  return {
    async priceGuide(itemType, itemNo, newOrUsed) {
      logger.warn({ businessEvent: 'price.lookup.failed', itemType, itemNo: itemNo.trim(), newOrUsed, reason: 'refused-key' }, 'a BrickLink price guide lookup failed');
      throw new PriceUnavailable('refused-key');
    },
  };
}

/** `meta.code` as a number, when the body has one. */
function metaCode(body: unknown): number | undefined {
  const meta = metaSchema.safeParse((body as { meta?: unknown } | undefined)?.meta);
  if (!meta.success || meta.data.code === undefined) return undefined;
  const code = Number(meta.data.code);
  return Number.isInteger(code) ? code : undefined;
}

/** `Retry-After` in milliseconds from now: delta seconds or an HTTP date, or undefined. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
