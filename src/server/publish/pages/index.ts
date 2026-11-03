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
import { renderPartsCsv, renderPartsXml } from './parts-download';
import { renderPartsPage } from './parts-page';
import { renderSegmentPage } from './segment-page';
import { renderSetPage } from './set-page';
import { hasPartsDownload, segmentsOf } from './values';

export { renderLanding } from './landing';
export { renderPartsCsv, renderPartsXml } from './parts-download';
export { renderPartsPage } from './parts-page';
export { renderSegmentPage } from './segment-page';
export { renderSetPage } from './set-page';

const HTML = 'text/html; charset=utf-8';

/**
 * Every page and asset of the catalogue: the landing, a page per item, the parts page when there
 * are parts, and the two assets. In selling mode (#211) also the split views the data offers
 * ([PUB-19]) and the parts download, `parts.csv` and `parts.xml`, when it holds lots ([PUB-20]).
 */
export function renderCataloguePages(data: PublicCatalogueData): CataloguePage[] {
  const pages: CataloguePage[] = [{ path: 'index.html', body: renderLanding(data), contentType: HTML }];
  const folders = new Set<string>();
  for (const item of [...data.items].sort(bySetNumber)) {
    const folder = itemFolder(item.id);
    if (folders.has(folder)) throw new Error('Two items in the catalogue data share an id.');
    folders.add(folder);
    pages.push({ path: `${folder}index.html`, body: renderSetPage(data, item), contentType: HTML });
  }
  if (data.parts !== null || segmentsOf(data).includes('parts')) pages.push({ path: 'parts/index.html', body: renderPartsPage(data, data.parts), contentType: HTML });
  for (const segment of segmentsOf(data)) {
    if (segment !== 'parts') pages.push({ path: `${segment}/index.html`, body: renderSegmentPage(data, segment), contentType: HTML });
  }
  if (hasPartsDownload(data)) {
    pages.push({ path: 'parts.csv', body: renderPartsCsv(data), contentType: 'text/csv; charset=utf-8' });
    pages.push({ path: 'parts.xml', body: renderPartsXml(data), contentType: 'application/xml; charset=utf-8' });
  }
  pages.push({ path: 'assets/catalogue.css', body: CATALOGUE_CSS, contentType: 'text/css; charset=utf-8' });
  pages.push({ path: 'assets/catalogue.js', body: CATALOGUE_JS, contentType: 'text/javascript; charset=utf-8' });
  return pages;
}
