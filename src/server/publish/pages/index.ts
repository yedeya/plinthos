/**
 * The public catalogue's pages (brief #154, Issue B; `docs/design/catalogue.md`): pure renderers
 * from the public data alone ([PUB-5]) to the files the publish step writes under `/c/{token}/`.
 * Every link and asset is relative, so the pages work under any token and never name it
 * ([PUB-4]); every page carries `noindex` ([PUB-2]); nothing here reads the database.
 */
import type { CataloguePage, PublicCatalogueData } from '../catalogue-data';
import { CATALOGUE_CSS } from './catalogue-css';
import { CATALOGUE_JS } from './catalogue-js';
import { itemFolder } from './html';
import { bySetNumber, renderLanding } from './landing';
import { renderPartsPage } from './parts-page';
import { renderSetPage } from './set-page';

export { renderLanding } from './landing';
export { renderPartsPage } from './parts-page';
export { renderSetPage } from './set-page';

const HTML = 'text/html; charset=utf-8';

/** Every page and asset of the catalogue: the landing, a page per item, the parts page when there are parts, and the two assets. */
export function renderCataloguePages(data: PublicCatalogueData): CataloguePage[] {
  const pages: CataloguePage[] = [{ path: 'index.html', body: renderLanding(data), contentType: HTML }];
  const folders = new Set<string>();
  for (const item of [...data.items].sort(bySetNumber)) {
    const folder = itemFolder(item.id);
    if (folders.has(folder)) throw new Error('Two items in the catalogue data share an id.');
    folders.add(folder);
    pages.push({ path: `${folder}index.html`, body: renderSetPage(data, item), contentType: HTML });
  }
  if (data.parts !== null) pages.push({ path: 'parts/index.html', body: renderPartsPage(data, data.parts), contentType: HTML });
  pages.push({ path: 'assets/catalogue.css', body: CATALOGUE_CSS, contentType: 'text/css; charset=utf-8' });
  pages.push({ path: 'assets/catalogue.js', body: CATALOGUE_JS, contentType: 'text/javascript; charset=utf-8' });
  return pages;
}
