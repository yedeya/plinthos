/**
 * Selling mode's split views of the items, `/c/{token}/sealed/` and `/c/{token}/used/`
 * ([PUB-19], #211): the items of one segment as the landing's cards, sealed or used by the
 * segment the data gives each item (`segmentOf`, [VAL-7]: every minifigure is used), and the
 * segment's subtotal of what the data holds, its estimated value and its asking price, so a buyer
 * interested in part of the lot sees a coherent offer. The loose parts' view is the parts page
 * (`./parts-page.ts`).
 */
import type { PublicCatalogueData } from '../catalogue-data';
import { html, toString } from './html';
import { bySetNumber, card } from './landing';
import { documentOf, foot, masthead } from './layout';
import { catalogueMessages as m, publishedDate } from './messages';
import { itemsIn, segmentSubtotal } from './values';

const ROOT = '../';

export type ItemSegment = 'sealed' | 'used';

export function renderSegmentPage(data: PublicCatalogueData, segment: ItemSegment): string {
  const items = [...itemsIn(data, segment)].sort(bySetNumber);
  const body = html`${masthead()}
<main class="page">
<nav><a class="back" href="${ROOT}index.html">${m.set.back}</a></nav>
<header class="set-head">
<h1>${m.segments.title[segment]}</h1>
<p class="muted">${m.summary.totals(items.filter((item) => item.kind === 'SET').length, items.filter((item) => item.kind !== 'SET').length, items.reduce((sum, item) => sum + item.quantity, 0))}</p>
${segmentSubtotal(data, segment)}
</header>
<section class="section" aria-label="${m.segments.title[segment]}">
${items.length === 0 ? html`<p class="empty">${m.segments.empty}</p>` : html`<ul class="grid">
${items.map((item, index) => card(data, item, index, ROOT))}</ul>`}
</section>
</main>
${foot(publishedDate(data.publishedAt))}`;
  return toString(documentOf({ root: ROOT, title: m.segments.title[segment], body }));
}
