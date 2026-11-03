/**
 * The loose parts' page, `/c/{token}/parts/` ([PUB-14]): the overview photos as a gallery and how
 * many lots and parts there are. With selling mode off, no price, no value and no lot list: the
 * data holds none.
 *
 * In selling mode it is the loose parts' split view ([PUB-19], #211): it adds the subtotal the
 * data holds, the parts' estimated value and asking price, the bulk lots, which are loose parts
 * too (`segmentOf`, [VAL-7]), as the landing's cards, and the parts download's links ([PUB-20]).
 * It is written then even with no parts imported, when there are bulk lots.
 */
import type { PublicCatalogueData, PublicParts } from '../catalogue-data';
import { gallery } from './gallery';
import { html, toString } from './html';
import { bySetNumber, card } from './landing';
import { documentOf, foot, masthead } from './layout';
import { catalogueMessages as m, publishedDate } from './messages';
import { downloadLinks, itemsIn, segmentsOf, segmentSubtotal } from './values';

const ROOT = '../';

export function renderPartsPage(data: PublicCatalogueData, parts: PublicParts | null): string {
  const split = segmentsOf(data).includes('parts');
  const bulk = split ? [...itemsIn(data, 'parts')].sort(bySetNumber) : [];
  const body = html`${masthead()}
<main class="page">
<nav><a class="back" href="${ROOT}index.html">${m.set.back}</a></nav>
<header class="set-head">
<h1>${m.parts.heading}</h1>
${parts === null ? '' : html`<p class="muted" data-parts-summary>${m.parts.summary(parts.quantity, parts.lots)}</p>`}
${split ? segmentSubtotal(data, 'parts') : ''}
</header>
${parts === null ? '' : gallery({ root: ROOT, subject: m.parts.subject, photos: parts.photos })}
${bulk.length === 0 ? '' : html`<section class="section" aria-label="${m.segments.bulk}">
<h2>${m.segments.bulk}</h2>
<ul class="grid">
${bulk.map((item, index) => card(data, item, index, ROOT))}</ul>
</section>`}
${split ? downloadLinks(data, ROOT) : ''}
</main>
${foot(publishedDate(data.publishedAt))}`;
  return toString(documentOf({ root: ROOT, title: m.parts.title, body }));
}
