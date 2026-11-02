/**
 * The document every catalogue page shares: `noindex` ([PUB-2]), no referrer, a content security
 * policy that allows only the snapshot's own stylesheet and script and images from the snapshot
 * or over `https://` (the catalogue's stock images), and the stylesheet and script by relative
 * URLs, so a page works under any token and never names it ([PUB-4]).
 */
import { html, type Interpolation, type Markup } from './html';
import { catalogueMessages as m } from './messages';

/** The snapshot's root, from a page: `''` for the landing, `'../../'` for a set page. */
export type Root = '' | '../' | '../../';

const CSP = "default-src 'none'; img-src 'self' https:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'";

export function documentOf({ root, title, body }: { readonly root: Root; readonly title: string; readonly body: Interpolation }): Markup {
  return html`<!doctype html>
<html lang="${m.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<link rel="stylesheet" href="${root}assets/catalogue.css">
<script src="${root}assets/catalogue.js" defer></script>
</head>
<body>
${body}
</body>
</html>
`;
}

/** The wordmark and the tagline at the top of every page. */
export function masthead(): Markup {
  return html`<header class="masthead"><p class="masthead__wordmark">${m.wordmark}</p><p class="masthead__tagline">${m.tagline}</p></header>`;
}

/** The date of the snapshot at the foot of every page. */
export function foot(published: string): Markup {
  return html`<footer class="foot"><p class="muted">${published === '' ? '' : m.published(published)}</p></footer>`;
}
