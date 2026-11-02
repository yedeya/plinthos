/**
 * The one Rebrickable client ([CAT-2]): every request to Rebrickable's API v3 goes through here.
 *
 * - **A timeout.** Each request is aborted after at most `REQUEST_TIMEOUT_MS`, or sooner when the
 *   caller's budget ends first.
 * - **One request a second.** Rebrickable allows "on average one request/sec, with some small
 *   allowance for burst traffic", answers 429 above it, and may ban an IP that ignores 429s. The
 *   limiter is module-level, so every provider in one server instance shares it.
 * - **At most two retries**, on a 429 or a 5xx only, with exponential backoff that waits at least
 *   what `Retry-After` asks. A wait that would end past the caller's `budgetMs` is not started:
 *   the call fails at once instead.
 * - **The key.** It is sent only in the `Authorization: key <key>` header, never in a URL, so no
 *   URL this module builds carries it. A failure is logged as `catalogue.lookup.failed` with its
 *   reason, never the key, the URL or the upstream's message ([CAT-4]). The logger also scrubs the
 *   linked key's value from every line (`src/server/logger.ts`).
 *
 * Theme names are resolved through `/lego/themes/{id}/` and kept in memory for the life of the
 * instance: themes are a small list that changes a few times a year. When one answer brings
 * several unknown themes at once, as a search can, the whole list is fetched in one request
 * instead of one request a theme, which at one request a second would spend the caller's budget.
 */
import { z } from 'zod';
import { linkedValue } from '../linked';
import { logger } from '../logger';

/** A set as the catalogue describes it ([CAT-1]). */
export interface CatalogueSet {
  /** Rebrickable's set number, with its variant suffix, such as `10294-1`. */
  setNum: string;
  name: string;
  /** The theme's own name, such as `Icons`. */
  theme: string;
  year: number;
  numParts: number;
  /** The stock image, on Rebrickable's CDN, or null when it has none. */
  imageUrl: string | null;
}

export interface CatalogueProvider {
  /** At most `SEARCH_PAGE_SIZE` sets matching a set number or a name. */
  searchSets(query: string, opts: { budgetMs: number }): Promise<CatalogueSet[]>;
  /** One set by its exact set number, or null when the catalogue does not know it. */
  getSet(setNum: string, opts: { budgetMs: number }): Promise<CatalogueSet | null>;
}

export type CatalogueUnavailableReason = 'timeout' | 'rate-limited' | 'refused-key' | 'upstream';

/** The catalogue could not answer: the caller answers `unavailable` ([CAT-5]). */
export class CatalogueUnavailable extends Error {
  override name = 'CatalogueUnavailable';
  constructor(readonly reason: CatalogueUnavailableReason) {
    super(`The set catalogue is unavailable: ${reason}.`);
  }
}

export const API_BASE = 'https://rebrickable.com/api/v3';
/** The longest one request may take ([CAT-2]). */
export const REQUEST_TIMEOUT_MS = 5000;
/** The shortest gap between two requests' starts, from one server instance ([CAT-2]). */
export const MIN_REQUEST_INTERVAL_MS = 1000;
/** Retries after the first attempt, on a 429 or a 5xx ([CAT-2]). */
export const MAX_RETRIES = 2;
/** The first retry's backoff; each next one doubles it. */
export const BASE_BACKOFF_MS = 1000;
export const SEARCH_PAGE_SIZE = 10;
/** Rebrickable's largest page, enough for every theme in one request. */
const THEME_LIST_PAGE_SIZE = 1000;

export interface ProviderOptions {
  fetch?: typeof fetch;
  /** Milliseconds, on any clock that `sleep` advances. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const setSchema = z.object({
  set_num: z.string().min(1),
  name: z.string(),
  year: z.number().int(),
  theme_id: z.number().int(),
  num_parts: z.number().int().nonnegative(),
  set_img_url: z.string().nullish(),
});
type RawSet = z.infer<typeof setSchema>;
const setPageSchema = z.object({ results: z.array(setSchema) });
const themeSchema = z.object({ id: z.number().int(), name: z.string() });
const themePageSchema = z.object({ results: z.array(themeSchema) });

/** The module-level limiter: one per server instance, shared by every provider in it ([CAT-2]). */
const limiter: { tail: Promise<void>; lastStart: number | undefined } = { tail: Promise.resolve(), lastStart: undefined };

/** Forgets the last request's time. Tests only: each starts with a fresh clock. */
export function resetRebrickableRateLimit(): void {
  limiter.tail = Promise.resolve();
  limiter.lastStart = undefined;
}

/** Theme names by id, kept for the life of the instance. */
const themeNames = new Map<number, string>();

/** Forgets every cached theme name. Tests only. */
export function clearThemeCache(): void {
  themeNames.clear();
}

type Answer = { status: 'ok'; body: unknown } | { status: 'not-found' };

/** The provider over Rebrickable's API v3, with `apiKey` sent in the header only. */
export function rebrickableProvider(apiKey: string, opts: ProviderOptions = {}): CatalogueProvider {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Waits for this instance's next free slot, or fails when it would come past the deadline. */
  async function takeSlot(deadline: number): Promise<void> {
    const previous = limiter.tail;
    let release: () => void = () => undefined;
    limiter.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const wait = limiter.lastStart === undefined ? 0 : Math.max(0, limiter.lastStart + MIN_REQUEST_INTERVAL_MS - now());
      if (now() + wait >= deadline) throw new CatalogueUnavailable('timeout');
      if (wait > 0) await sleep(wait);
      limiter.lastStart = now();
    } finally {
      release();
    }
  }

  /** One attempt, aborted after the timeout or at the deadline, whichever comes first. */
  async function attempt(path: string, deadline: number): Promise<{ response: Response; body: unknown } | { response: Response }> {
    await takeSlot(deadline);
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - now());
    if (timeoutMs <= 0) throw new CatalogueUnavailable('timeout');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CatalogueUnavailable('timeout'));
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        headers: { Authorization: `key ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { response };
      return { response, body: (await response.json()) as unknown };
    })();
    // A late rejection of the losing promise is not an unhandled one.
    request.catch(() => undefined);
    try {
      return await Promise.race([request, timedOut]);
    } catch (error) {
      if (error instanceof CatalogueUnavailable) throw error;
      if (controller.signal.aborted) throw new CatalogueUnavailable('timeout');
      // A network failure or a body that is not JSON. Its message is not kept: it may hold the URL.
      throw new CatalogueUnavailable('upstream');
    } finally {
      clearTimeout(timer);
    }
  }

  /** A GET with the retries, inside the deadline. A 404 is `not-found`; any other refusal throws. */
  async function get(path: string, deadline: number): Promise<Answer> {
    for (let retry = 0; ; retry += 1) {
      const result = await attempt(path, deadline);
      const { status } = result.response;
      if ('body' in result) return { status: 'ok', body: result.body };
      if (status === 404) return { status: 'not-found' };
      if (status === 401 || status === 403) throw new CatalogueUnavailable('refused-key');
      const retryable = status === 429 || status >= 500;
      const reason = status === 429 ? 'rate-limited' : 'upstream';
      if (!retryable || retry >= MAX_RETRIES) throw new CatalogueUnavailable(reason);
      const backoff = BASE_BACKOFF_MS * 2 ** retry;
      const delay = Math.max(backoff, retryAfterMs(result.response.headers.get('retry-after'), now()) ?? 0);
      // Never wait into, or past, the end of the caller's budget.
      if (now() + delay >= deadline) throw new CatalogueUnavailable(reason);
      await sleep(delay);
    }
  }

  /** The theme names for these ids, from the cache or from Rebrickable. */
  async function resolveThemes(ids: readonly number[], deadline: number): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !themeNames.has(id));
    if (missing.length > 1) {
      const answer = await get(`/lego/themes/?page_size=${THEME_LIST_PAGE_SIZE}`, deadline);
      if (answer.status === 'ok') {
        const page = themePageSchema.safeParse(answer.body);
        if (!page.success) throw new CatalogueUnavailable('upstream');
        for (const theme of page.data.results) themeNames.set(theme.id, theme.name);
      }
    }
    for (const id of missing.filter((theme) => !themeNames.has(theme))) {
      const answer = await get(`/lego/themes/${id}/`, deadline);
      if (answer.status === 'not-found') throw new CatalogueUnavailable('upstream');
      const theme = themeSchema.safeParse(answer.body);
      if (!theme.success) throw new CatalogueUnavailable('upstream');
      themeNames.set(theme.data.id, theme.data.name);
    }
  }

  function toCatalogueSet(raw: RawSet): CatalogueSet {
    return {
      setNum: raw.set_num,
      name: raw.name,
      theme: themeNames.get(raw.theme_id) ?? '',
      year: raw.year,
      numParts: raw.num_parts,
      imageUrl: raw.set_img_url ?? null,
    };
  }

  /** Runs one operation, logging a failure once with its reason and nothing that identifies the key. */
  async function logged<T>(operation: 'search' | 'getSet', work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const reason: CatalogueUnavailableReason = error instanceof CatalogueUnavailable ? error.reason : 'upstream';
      logger.warn({ businessEvent: 'catalogue.lookup.failed', operation, reason }, 'a set catalogue lookup failed');
      throw error instanceof CatalogueUnavailable ? error : new CatalogueUnavailable('upstream');
    }
  }

  return {
    searchSets(query, { budgetMs }) {
      return logged('search', async () => {
        const deadline = now() + budgetMs;
        const answer = await get(`/lego/sets/?search=${encodeURIComponent(query.trim())}&page_size=${SEARCH_PAGE_SIZE}`, deadline);
        if (answer.status === 'not-found') return [];
        const page = setPageSchema.safeParse(answer.body);
        if (!page.success) throw new CatalogueUnavailable('upstream');
        const sets = page.data.results.slice(0, SEARCH_PAGE_SIZE);
        await resolveThemes(
          sets.map((set) => set.theme_id),
          deadline,
        );
        return sets.map(toCatalogueSet);
      });
    },
    getSet(setNum, { budgetMs }) {
      return logged('getSet', async () => {
        const deadline = now() + budgetMs;
        const answer = await get(`/lego/sets/${encodeURIComponent(setNum.trim())}/`, deadline);
        if (answer.status === 'not-found') return null;
        const set = setSchema.safeParse(answer.body);
        if (!set.success) throw new CatalogueUnavailable('upstream');
        await resolveThemes([set.data.theme_id], deadline);
        return toCatalogueSet(set.data);
      });
    },
  };
}

/** The provider over the server function's linked `RebrickableApiKey` ([CAT-4]). Without it, every call is `refused-key`. */
export function linkedCatalogueProvider(opts: ProviderOptions = {}): CatalogueProvider {
  const apiKey = linkedValue('RebrickableApiKey');
  if (apiKey !== undefined && apiKey.trim() !== '') return rebrickableProvider(apiKey, opts);
  const refuse = async (operation: 'search' | 'getSet'): Promise<never> => {
    logger.warn({ businessEvent: 'catalogue.lookup.failed', operation, reason: 'refused-key' }, 'a set catalogue lookup failed');
    throw new CatalogueUnavailable('refused-key');
  };
  return { searchSets: () => refuse('search'), getSet: () => refuse('getSet') };
}

/** `Retry-After` in milliseconds from now: delta seconds or an HTTP date, or undefined. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
