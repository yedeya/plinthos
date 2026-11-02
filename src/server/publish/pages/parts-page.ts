/**
 * The loose parts' page, `/c/{token}/parts/` ([PUB-14]): the overview photos as a gallery and how
 * many lots and parts there are. No price, no value and no lot list: the data holds none.
 */
import type { PublicCatalogueData, PublicParts } from '../catalogue-data';
import { gallery } from './gallery';
import { html, toString } from './html';
import { documentOf, foot, masthead } from './layout';
import { catalogueMessages as m, publishedDate } from './messages';

const ROOT = '../';

export function renderPartsPage(data: PublicCatalogueData, parts: PublicParts): string {
  const body = html`${masthead()}
<main class="page">
<nav><a class="back" href="${ROOT}index.html">${m.set.back}</a></nav>
<header class="set-head">
<h1>${m.parts.heading}</h1>
<p class="muted" data-parts-summary>${m.parts.summary(parts.quantity, parts.lots)}</p>
</header>
${gallery({ root: ROOT, subject: m.parts.subject, photos: parts.photos })}
</main>
${foot(publishedDate(data.publishedAt))}`;
  return toString(documentOf({ root: ROOT, title: m.parts.title, body }));
}
