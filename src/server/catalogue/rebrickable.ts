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
 * Each theme's parent is kept with its name, so a set answers its top-level theme too, the root
 * of Rebrickable's theme tree above it ([ITEM-11], [ITEM-12]). A sub-theme whose ancestors aren't
 * cached reads them from the whole list; when that fails, or the chain is broken, the set answers
 * a null top-level theme rather than failing the lookup.
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
  /** Rebrickable's id for that theme; null on a row stored before it was kept ([ITEM-11]). */
  themeId: number | null;
  /** The name of the theme's top-level theme, or null when it could not be read ([ITEM-12]). */
  topTheme: string | null;
  year: number;
  numParts: number;
  /** The stock image, on Rebrickable's CDN, or null when it has none. */
  imageUrl: string | null;
}

/**
 * What a call may spend, and, for a search the browser has given up on, the signal that says so:
 * an aborted call reserves no request slot, sends no request, and stops waiting for its slot.
 */
export interface CallOptions {
  budgetMs: number;
  signal?: AbortSignal;
}

/** A theme in Rebrickable's tree: `parentId` is null for a top-level theme. */
export interface CatalogueTheme {
  id: number;
  name: string;
  parentId: number | null;
}

export interface CatalogueProvider {
  /** At most `SEARCH_PAGE_SIZE` sets matching a set number or a name. */
  searchSets(query: string, opts: CallOptions): Promise<CatalogueSet[]>;
  /** One set by its exact set number, or null when the catalogue does not know it. */
  getSet(setNum: string, opts: CallOptions): Promise<CatalogueSet | null>;
  /** Every theme in Rebrickable's tree, every page of it, in the list's order ([ITEM-13]). */
  listThemes(opts: CallOptions): Promise<CatalogueTheme[]>;
}

/** What `catalogue.lookup.failed` names as its `operation`. */
type CatalogueOperation = 'search' | 'getSet' | 'themes';

/** `aborted`: the caller gave up first, so nothing failed; it is never logged as a failure. */
export type CatalogueUnavailableReason = 'timeout' | 'rate-limited' | 'refused-key' | 'upstream' | 'aborted';

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
/** The most pages of themes read, should the list ever outgrow one: a bound, not an expectation. */
const THEME_LIST_MAX_PAGES = 10;

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
// `parent_id` is read where Rebrickable gives it; a theme without one has no root to answer.
const themeSchema = z.object({ id: z.number().int(), name: z.string(), parent_id: z.number().int().nullish() });
type RawTheme = z.infer<typeof themeSchema>;
const themePageSchema = z.object({ results: z.array(themeSchema), next: z.string().nullish() });

/**
 * The module-level limiter: one per server instance, shared by every provider in it ([CAT-2]).
 * `lastStart` is the start of the latest slot reserved, which may still lie ahead.
 */
const limiter: { lastStart: number | undefined } = { lastStart: undefined };

/** Forgets the last request's time. Tests only: each starts with a fresh clock. */
export function resetRebrickableRateLimit(): void {
  limiter.lastStart = undefined;
}

/** A cached theme: `parentId` is undefined when Rebrickable's answer did not say. */
interface CachedTheme {
  readonly name: string;
  readonly parentId: number | null | undefined;
}

/** Themes by id, with their names and parents, kept for the life of the instance. */
const themeCache = new Map<number, CachedTheme>();

/** Forgets every cached theme. Tests only. */
export function clearThemeCache(): void {
  themeCache.clear();
}

function cacheTheme(raw: RawTheme): void {
  themeCache.set(raw.id, { name: raw.name, parentId: raw.parent_id });
}

/**
 * The name of the top-level theme above `id`, following each theme's parent to the root, which is
 * the theme itself when it has none ([ITEM-11]). Undefined when a theme on the way is missing or
 * names no parent, or the parents loop.
 */
export function topThemeOf(id: number, themes: ReadonlyMap<number, { readonly name: string; readonly parentId: number | null | undefined }>): string | undefined {
  const seen = new Set<number>();
  for (let current = id; ; ) {
    const theme = themes.get(current);
    if (theme === undefined || theme.parentId === undefined || seen.has(current)) return undefined;
    if (theme.parentId === null) return theme.name;
    seen.add(current);
    current = theme.parentId;
  }
}

type Answer = { status: 'ok'; body: unknown } | { status: 'not-found' };

/** Whether the caller has given up; a function, so a check after an `await` reads it afresh. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The provider over Rebrickable's API v3, with `apiKey` sent in the header only. */
export function rebrickableProvider(apiKey: string, opts: ProviderOptions = {}): CatalogueProvider {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * Reserves this instance's next free slot and waits for it, or fails at once when it would come
   * at or past the deadline. The reservation is made before the first `await`, so a call never
   * waits behind callers with longer budgets only to learn its slot is too late, and a call that
   * fails here reserves nothing.
   */
  async function takeSlot(deadline: number, signal: AbortSignal | undefined): Promise<void> {
    if (isAborted(signal)) throw new CatalogueUnavailable('aborted');
    const current = now();
    const before = limiter.lastStart;
    const start = before === undefined ? current : Math.max(current, before + MIN_REQUEST_INTERVAL_MS);
    if (start >= deadline) throw new CatalogueUnavailable('timeout');
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
        // Give the slot back when nobody has queued behind it, so the next caller needn't wait for it.
        if (limiter.lastStart === start) limiter.lastStart = before;
        throw new CatalogueUnavailable('aborted');
      }
    }
    if (isAborted(signal)) throw new CatalogueUnavailable('aborted');
  }

  /** One attempt, aborted after the timeout, at the deadline or when the caller gives up, whichever comes first. */
  async function attempt(path: string, deadline: number, signal: AbortSignal | undefined): Promise<{ response: Response; body: unknown } | { response: Response }> {
    await takeSlot(deadline, signal);
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - now());
    if (timeoutMs <= 0) throw new CatalogueUnavailable('timeout');
    const controller = new AbortController();
    const giveUp = () => controller.abort();
    signal?.addEventListener('abort', giveUp, { once: true });
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
      if (isAborted(signal)) throw new CatalogueUnavailable('aborted');
      if (controller.signal.aborted) throw new CatalogueUnavailable('timeout');
      // A network failure or a body that is not JSON. Its message is not kept: it may hold the URL.
      throw new CatalogueUnavailable('upstream');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
    }
  }

  /** A GET with the retries, inside the deadline. A 404 is `not-found`; any other refusal throws. */
  async function get(path: string, deadline: number, signal?: AbortSignal): Promise<Answer> {
    for (let retry = 0; ; retry += 1) {
      const result = await attempt(path, deadline, signal);
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
      if (isAborted(signal)) throw new CatalogueUnavailable('aborted');
      await sleep(delay);
    }
  }

  /** Every theme, every page of the list, each cached as it is read. */
  async function loadThemeList(deadline: number, signal?: AbortSignal): Promise<RawTheme[]> {
    const themes: RawTheme[] = [];
    for (let page = 1; page <= THEME_LIST_MAX_PAGES; page += 1) {
      const answer = await get(`/lego/themes/?${page === 1 ? '' : `page=${page}&`}page_size=${THEME_LIST_PAGE_SIZE}`, deadline, signal);
      if (answer.status === 'not-found') break;
      const parsed = themePageSchema.safeParse(answer.body);
      if (!parsed.success) throw new CatalogueUnavailable('upstream');
      for (const theme of parsed.data.results) cacheTheme(theme);
      themes.push(...parsed.data.results);
      if (parsed.data.next === null || parsed.data.next === undefined) break;
    }
    return themes;
  }

  /** The themes for these ids, with their parents, from the cache or from Rebrickable. */
  async function resolveThemes(ids: readonly number[], deadline: number, signal?: AbortSignal): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !themeCache.has(id));
    const listed = missing.length > 1;
    if (listed) await loadThemeList(deadline, signal);
    for (const id of missing.filter((theme) => !themeCache.has(theme))) {
      const answer = await get(`/lego/themes/${id}/`, deadline, signal);
      if (answer.status === 'not-found') throw new CatalogueUnavailable('upstream');
      const theme = themeSchema.safeParse(answer.body);
      if (!theme.success) throw new CatalogueUnavailable('upstream');
      cacheTheme(theme.data);
    }
    // A sub-theme's ancestors come from the list, in one request. The names are resolved by now,
    // so a list that can't be read costs the set its top-level theme only ([ITEM-12]).
    if (!listed && ids.some((id) => topThemeOf(id, themeCache) === undefined)) {
      try {
        await loadThemeList(deadline, signal);
      } catch (error) {
        const reason: CatalogueUnavailableReason = error instanceof CatalogueUnavailable ? error.reason : 'upstream';
        if (reason === 'aborted') throw error;
        logger.warn({ businessEvent: 'catalogue.lookup.failed', operation: 'themes', reason }, 'a set catalogue lookup failed');
      }
    }
  }

  function toCatalogueSet(raw: RawSet): CatalogueSet {
    return {
      setNum: raw.set_num,
      name: raw.name,
      theme: themeCache.get(raw.theme_id)?.name ?? '',
      themeId: raw.theme_id,
      topTheme: topThemeOf(raw.theme_id, themeCache) ?? null,
      year: raw.year,
      numParts: raw.num_parts,
      imageUrl: raw.set_img_url ?? null,
    };
  }

  /** Runs one operation, logging a failure once with its reason and nothing that identifies the key. */
  async function logged<T>(operation: CatalogueOperation, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const reason: CatalogueUnavailableReason = error instanceof CatalogueUnavailable ? error.reason : 'upstream';
      // A call the browser gave up on did not fail: logging it would page nobody but mislead the log.
      if (reason === 'aborted') throw error;
      logger.warn({ businessEvent: 'catalogue.lookup.failed', operation, reason }, 'a set catalogue lookup failed');
      throw error instanceof CatalogueUnavailable ? error : new CatalogueUnavailable('upstream');
    }
  }

  return {
    searchSets(query, { budgetMs, signal }) {
      return logged('search', async () => {
        const deadline = now() + budgetMs;
        const answer = await get(`/lego/sets/?search=${encodeURIComponent(query.trim())}&page_size=${SEARCH_PAGE_SIZE}`, deadline, signal);
        if (answer.status === 'not-found') return [];
        const page = setPageSchema.safeParse(answer.body);
        if (!page.success) throw new CatalogueUnavailable('upstream');
        const sets = page.data.results.slice(0, SEARCH_PAGE_SIZE);
        await resolveThemes(
          sets.map((set) => set.theme_id),
          deadline,
          signal,
        );
        return sets.map(toCatalogueSet);
      });
    },
    getSet(setNum, { budgetMs, signal }) {
      return logged('getSet', async () => {
        const deadline = now() + budgetMs;
        const answer = await get(`/lego/sets/${encodeURIComponent(setNum.trim())}/`, deadline, signal);
        if (answer.status === 'not-found') return null;
        const set = setSchema.safeParse(answer.body);
        if (!set.success) throw new CatalogueUnavailable('upstream');
        await resolveThemes([set.data.theme_id], deadline, signal);
        return toCatalogueSet(set.data);
      });
    },
    listThemes({ budgetMs, signal }) {
      return logged('themes', async () => {
        const themes = await loadThemeList(now() + budgetMs, signal);
        return themes.map((theme) => ({ id: theme.id, name: theme.name, parentId: theme.parent_id ?? null }));
      });
    },
  };
}

/** The provider over the server function's linked `RebrickableApiKey` ([CAT-4]). Without it, every call is `refused-key`. */
export function linkedCatalogueProvider(opts: ProviderOptions = {}): CatalogueProvider {
  const apiKey = linkedValue('RebrickableApiKey');
  if (apiKey !== undefined && apiKey.trim() !== '') return rebrickableProvider(apiKey, opts);
  const refuse = async (operation: CatalogueOperation): Promise<never> => {
    logger.warn({ businessEvent: 'catalogue.lookup.failed', operation, reason: 'refused-key' }, 'a set catalogue lookup failed');
    throw new CatalogueUnavailable('refused-key');
  };
  return { searchSets: () => refuse('search'), getSet: () => refuse('getSet'), listThemes: () => refuse('themes') };
}

/** `Retry-After` in milliseconds from now: delta seconds or an HTTP date, or undefined. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}
