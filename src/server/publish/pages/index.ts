/**
 * STAND-IN for #163's page renderers, so the publish step (#162) has pages to write until they
 * land. At merge, #163's `src/server/publish/pages/index.ts` replaces this file whole.
 *
 * It renders one plain landing page that lists the set numbers, escaped, from the catalogue's
 * data alone, with the `noindex` and `no-referrer` the real pages carry too ([PUB-2]).
 */
import type { CataloguePage, PublicCatalogueData } from '../catalogue-data';

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export function renderCataloguePages(data: PublicCatalogueData): CataloguePage[] {
  const list =
    data.items.length === 0 ? '<p>Nothing is published yet.</p>' : `<ul>\n${data.items.map((item) => `<li>${escape(item.setNum)}</li>`).join('\n')}\n</ul>`;
  const body = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Catalogue</title>',
    '</head>',
    '<body>',
    '<main>',
    list,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return [{ path: 'index.html', body, contentType: 'text/html; charset=utf-8' }];
}
