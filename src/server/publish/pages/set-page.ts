/**
 * A set's page, `/c/{token}/s/{id}/` ([PUB-12], `docs/design/catalogue.md` § Set detail): the
 * gallery of the owner's photos and the stock image, then exactly the fields [PUB-12] lists. It
 * reads nothing else of the item, so nothing else can reach the page.
 */
import type { PublicCatalogueData, PublicItem } from '../catalogue-data';
import { gallery } from './gallery';
import { html, toString } from './html';
import { documentOf, foot, masthead } from './layout';
import { catalogueMessages as m, publishedDate } from './messages';

const ROOT = '../../';

export function renderSetPage(data: PublicCatalogueData, item: PublicItem): string {
  const title = m.set.title(item.setNum, item.name);
  const yesNo = (value: boolean) => (value ? m.set.yes : m.set.no);
  const missing = !item.complete && item.missingNotes !== null && item.missingNotes.trim() !== '';
  const body = html`${masthead()}
<main class="page">
<nav><a class="back" href="${ROOT}index.html">${m.set.back}</a></nav>
<header class="set-head">
<h1><span class="set-head__num">${item.setNum}</span> ${item.name}</h1>
<p class="muted">${m.set.meta(item.theme, item.year, item.numParts)}</p>
</header>
${gallery({ root: ROOT, subject: title, photos: item.photos, stock: { url: item.stockImageUrl, name: item.name } })}
<section class="section" aria-label="${m.set.details}">
<dl class="facts">
<div><dt>${m.set.condition}</dt><dd>${m.condition[item.condition]}</dd></div>
<div><dt>${m.set.complete}</dt><dd>${yesNo(item.complete)}</dd></div>
${missing ? html`<div><dt>${m.set.missing}</dt><dd class="prose">${item.missingNotes}</dd></div>` : ''}
<div><dt>${m.set.instructions}</dt><dd>${yesNo(item.hasInstructions)}</dd></div>
<div><dt>${m.set.quantity}</dt><dd>${item.quantity}</dd></div>
</dl>
${item.description.trim() === '' ? '' : html`<p class="prose" aria-label="${m.set.description}">${item.description}</p>`}
</section>
</main>
${foot(publishedDate(data.publishedAt))}`;
  return toString(documentOf({ root: ROOT, title, body }));
}
