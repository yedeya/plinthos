/**
 * The catalogue pages' one way to build markup: a tagged template whose every interpolation is
 * escaped unless it is markup this helper made itself (`docs/design/catalogue.md`, [PUB-9]). So
 * no text the owner typed, and no field of the data, can become markup: the owner's intro,
 * contact text, set names and descriptions all go through `escapeHtml`.
 *
 * Every attribute in these templates is double-quoted, and the escape covers both quotes all the
 * same. URLs get their own checks: a stock image must be `https://`, and a photo path or an
 * item's id must be a plain relative path, so neither can carry a `javascript:` URL or climb out
 * of the snapshot's folder.
 */

const MARKUP = Symbol('markup');

/** Markup that `html` made, so it is already escaped. */
export interface Markup {
  readonly [MARKUP]: string;
}

export type Interpolation = Markup | string | number | boolean | null | undefined | readonly Interpolation[];

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapes text for an element's content or a quoted attribute's value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (character) => ESCAPES[character] ?? character);
}

function isMarkup(value: unknown): value is Markup {
  return typeof value === 'object' && value !== null && MARKUP in value;
}

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (isMarkup(value)) return value[MARKUP];
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

/** Builds markup: the template's literal parts are markup, every value is escaped text. */
export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): Markup {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '');
  });
  return { [MARKUP]: out };
}

/** The finished markup as a string. */
export function toString(markup: Markup): string {
  return markup[MARKUP];
}

export class UnsafeCatalogueDataError extends Error {
  override name = 'UnsafeCatalogueDataError';
}

/** A stock image's URL, only when it is `https://`; anything else is left out. */
export function httpsUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

const RELATIVE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/;

/**
 * A path inside the snapshot, such as `p/<random>.webp`: relative, without a scheme, a leading
 * slash or a `..`. Anything else is the publish step's mistake, so it fails the render, and the
 * publish leaves the previous catalogue online ([OPS-6]).
 */
export function snapshotRelative(path: string): string {
  if (!RELATIVE_PATH.test(path) || path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new UnsafeCatalogueDataError('A photo path in the catalogue data is not a plain relative path.');
  }
  return path;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An item's id, which names its folder `s/{id}/`: one plain path segment. */
export function itemFolder(id: string): string {
  if (!ID.test(id)) throw new UnsafeCatalogueDataError('An item id in the catalogue data is not a plain path segment.');
  return `s/${id}/`;
}
