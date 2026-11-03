/**
 * An item's page, `/c/{token}/s/{id}/` ([PUB-12], `docs/design/catalogue.md` § Set detail): the
 * gallery of the owner's photos and the stock image, then exactly the fields [PUB-12] lists. It
 * reads nothing else of the item, so nothing else can reach the page. A minifigure, bulk lot or
 * other item (#202) has no theme, year, piece count or stock image: its page says what it is,
 * its reference number, a bulk lot's approximate pieces and weight, and leaves out a completeness
 * or instructions the owner did not state.
 *
 * Its estimated value, with the day it is estimated as of, only when the data holds one, which
 * it does only while the settings show market values (#211, [PUB-17], [PUB-18]).
 */
import type { PublicCatalogueData, PublicItem } from '../catalogue-data';
import { gallery } from './gallery';
import { html, toString } from './html';
import { documentOf, foot, masthead } from './layout';
import { catalogueMessages as m, publishedDate } from './messages';
import { itemValue } from './values';

const ROOT = '../../';

export function renderSetPage(data: PublicCatalogueData, item: PublicItem): string {
  const title = m.set.title(item.setNum, item.name);
  const isSet = item.kind === 'SET';
  const yesNo = (value: boolean) => (value ? m.set.yes : m.set.no);
  const value = itemValue(data, item);
  const missing = item.complete === false && item.missingNotes !== null && item.missingNotes.trim() !== '';
  const fact = (label: string, value: string | number | null) => (value === null ? '' : html`<div><dt>${label}</dt><dd>${value}</dd></div>
`);
  const meta = isSet
    ? item.theme !== null && item.year !== null && item.numParts !== null
      ? m.set.meta(item.theme, item.year, item.numParts)
      : ''
    : m.kind[item.kind];
  const body = html`${masthead()}
<main class="page">
<nav><a class="back" href="${ROOT}index.html">${m.set.back}</a></nav>
<header class="set-head">
<h1>${item.setNum === null ? '' : html`<span class="set-head__num">${item.setNum}</span> `}${item.name}</h1>
<p class="muted">${meta}</p>
</header>
${gallery({ root: ROOT, subject: title, photos: item.photos, ...(isSet ? { stock: { url: item.stockImageUrl, name: item.name } } : {}) })}
<section class="section" aria-label="${m.set.details}">
<dl class="facts">
${fact(m.set.refNo, item.refNo)}${fact(m.set.approxParts, item.approxParts === null ? null : m.set.count(item.approxParts))}${fact(m.set.approxWeight, item.approxWeightG === null ? null : m.set.grams(item.approxWeightG))}<div><dt>${m.set.condition}</dt><dd>${m.condition[item.condition]}</dd></div>
${item.complete === null ? '' : html`<div><dt>${m.set.complete}</dt><dd>${yesNo(item.complete)}</dd></div>`}
${missing ? html`<div><dt>${m.set.missing}</dt><dd class="prose">${item.missingNotes}</dd></div>` : ''}
${item.hasInstructions === null ? '' : html`<div><dt>${m.set.instructions}</dt><dd>${yesNo(item.hasInstructions)}</dd></div>`}
<div><dt>${m.set.quantity}</dt><dd>${item.quantity}</dd></div>
${value === null ? '' : html`<div data-value><dt>${m.values.value}</dt><dd>${value.amount}${value.estimated === '' ? '' : html` <span class="muted">${value.estimated}</span>`}</dd></div>`}
</dl>
${item.description.trim() === '' ? '' : html`<p class="prose" aria-label="${m.set.description}">${item.description}</p>`}
</section>
</main>
${foot(publishedDate(data.publishedAt))}`;
  return toString(documentOf({ root: ROOT, title, body }));
}
