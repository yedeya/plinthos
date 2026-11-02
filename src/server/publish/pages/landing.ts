/**
 * The landing, `/c/{token}/` (`docs/design/catalogue.md` § Landing): the intro, the summary, the
 * grid of every item and the contact text.
 *
 * The summary is counted here from the data alone ([PUB-10]): sets per condition, items with each
 * set's quantity, and the loose parts when there are any. The grid is in the HTML, the sets by set
 * number and every other item after them by name (#202), each card one plain link, so it works
 * without the script ([PUB-11]). The filter and sort
 * controls are real form controls, hidden until the script, which reads the cards' `data-*`
 * attributes, shows them: without it they could do nothing.
 */
import type { PublicCatalogueData, PublicCondition, PublicItem, PublicKind } from '../catalogue-data';
import { html, httpsUrl, itemFolder, snapshotRelative, toString, type Markup } from './html';
import { documentOf, foot, masthead } from './layout';
import { catalogueMessages as m, publishedDate } from './messages';

export const CONDITIONS: readonly PublicCondition[] = ['SEALED', 'USED_WITH_BOX', 'USED_NO_BOX'];
export const KINDS: readonly PublicKind[] = ['SET', 'MINIFIG', 'BULK', 'OTHER'];

/**
 * Set numbers in their natural order, `7140-1` before `10294-1`, and every item that is not a set
 * after the sets, by name (#202): the same order the script sorts by.
 */
export function bySetNumber(a: PublicItem, b: PublicItem): number {
  if ((a.setNum === null) !== (b.setNum === null)) return a.setNum === null ? 1 : -1;
  const key = (item: PublicItem) => item.setNum ?? item.name;
  return key(a).localeCompare(key(b), 'en', { numeric: true }) || a.id.localeCompare(b.id);
}

export interface CatalogueSummary {
  readonly sets: number;
  /** The items that are not sets (#202). */
  readonly others: number;
  readonly items: number;
  readonly perCondition: ReadonlyMap<PublicCondition, number>;
  readonly parts: { readonly quantity: number; readonly lots: number } | null;
}

/** The landing's numbers, from the data alone ([PUB-10]). */
export function summarize(data: PublicCatalogueData): CatalogueSummary {
  const perCondition = new Map<PublicCondition, number>(CONDITIONS.map((condition) => [condition, 0]));
  for (const item of data.items) perCondition.set(item.condition, (perCondition.get(item.condition) ?? 0) + 1);
  // The data says there are loose parts by holding a summary, as the parts section reads it too.
  const parts = data.parts === null ? null : { quantity: data.parts.quantity, lots: data.parts.lots };
  const sets = data.items.filter((item) => item.kind === 'SET').length;
  return { sets, others: data.items.length - sets, items: data.items.reduce((sum, item) => sum + item.quantity, 0), perCondition, parts };
}

/** Plain text with its line breaks kept: CSS shows them (`white-space: pre-line`). */
function prose(text: string, className: string): Markup {
  return html`<p class="${className}">${text}</p>`;
}

/**
 * A card's line under the name: a set's theme and year; a bulk lot's approximate pieces and
 * weight; for any other item, what it is (#202).
 */
function cardMeta(item: PublicItem): string {
  if (item.kind === 'SET') return item.theme !== null && item.year !== null ? m.grid.meta(item.theme, item.year) : '';
  const approx = item.kind === 'BULK' ? m.approx(item.approxParts, item.approxWeightG) : '';
  return [m.kind[item.kind], approx].filter((part) => part !== '').join(' · ');
}

function card(item: PublicItem, index: number): Markup {
  // A stock image is a set's alone (#202).
  const stock = item.kind === 'SET' ? httpsUrl(item.stockImageUrl) : null;
  const cover = item.photos[0];
  // [PUB-11]: the set's stock image by default, else the owner's cover.
  const image =
    stock !== null
      ? html`<img src="${stock}" alt="${m.gallery.stockAlt(item.name)}" loading="lazy" decoding="async" width="320" height="320" referrerpolicy="no-referrer">`
      : cover !== undefined
        ? html`<img src="${snapshotRelative(cover.thumb)}" alt="${m.gallery.photoAlt(m.set.title(item.setNum, item.name), 1, item.photos.length)}" loading="lazy" decoding="async" width="320" height="320">`
        : html`<span class="card__none">${m.grid.noPhoto}</span>`;
  // A non-set's number line is its reference number, when it has one.
  const number = item.setNum ?? item.refNo ?? '';
  return html`<li class="card" data-index="${index}" data-kind="${item.kind}" data-set-num="${item.setNum ?? ''}" data-name="${item.name}" data-year="${item.year ?? ''}" data-theme="${item.theme ?? ''}" data-condition="${item.condition}">
<a class="card__link" href="${itemFolder(item.id)}index.html">
<span class="card__media">${image}</span>
${number === '' ? '' : html`<span class="card__num">${number}</span>
`}<span class="card__name">${item.name}</span>
<span class="card__meta">${cardMeta(item)}</span>
<span class="chip chip--${item.condition.toLowerCase().replaceAll('_', '-')}">${m.condition[item.condition]}</span>
</a>
</li>
`;
}

function filters(items: readonly PublicItem[]): Markup {
  const themes = [...new Set(items.flatMap((item) => (item.theme === null ? [] : [item.theme])))].sort((a, b) => a.localeCompare(b, 'en'));
  // The kind filter (#202), offered once the catalogue holds more than one kind.
  const kinds = KINDS.filter((kind) => items.some((item) => item.kind === kind));
  return html`<form class="filters" data-catalogue-filters hidden aria-label="${m.grid.filters}">
${
  kinds.length < 2
    ? ''
    : html`<label class="field"><span class="field__label">${m.grid.kind}</span>
<select name="kind"><option value="">${m.grid.allKinds}</option>
${kinds.map((kind) => html`<option value="${kind}">${m.grid.kinds[kind]}</option>
`)}</select></label>
`
}
<fieldset class="choices">
<legend>${m.grid.condition}</legend>
<label class="choice"><input type="radio" name="condition" value="" checked> ${m.grid.allConditions}</label>
${CONDITIONS.map((condition) => html`<label class="choice"><input type="radio" name="condition" value="${condition}"> ${m.condition[condition]}</label>
`)}</fieldset>
<label class="field"><span class="field__label">${m.grid.theme}</span>
<select name="theme"><option value="">${m.grid.allThemes}</option>
${themes.map((theme) => html`<option value="${theme}">${theme}</option>
`)}</select></label>
<label class="field"><span class="field__label">${m.grid.sort}</span>
<select name="sort"><option value="setNum">${m.grid.sortBy.setNum}</option><option value="year">${m.grid.sortBy.year}</option><option value="name">${m.grid.sortBy.name}</option></select></label>
</form>`;
}

function summarySection(summary: CatalogueSummary): Markup {
  const conditions = CONDITIONS.filter((condition) => (summary.perCondition.get(condition) ?? 0) > 0).map((condition) => m.summary.perCondition(m.condition[condition], summary.perCondition.get(condition) ?? 0));
  return html`<section class="summary" aria-label="${m.summary.label}" data-summary>
<p class="summary__totals">${m.summary.totals(summary.sets, summary.others, summary.items)}</p>
${conditions.length === 0 ? '' : html`<p class="summary__conditions">${conditions.join(' · ')}</p>`}
${summary.parts === null ? '' : html`<p class="summary__parts">${m.summary.parts(summary.parts.quantity, summary.parts.lots)}</p>`}
</section>`;
}

function partsSection(data: PublicCatalogueData): Markup {
  if (data.parts === null) return html``;
  const thumbs = data.parts.photos.slice(0, 3);
  return html`<section class="section" aria-labelledby="parts-heading">
<h2 id="parts-heading">${m.parts.heading}</h2>
<a class="parts-link" href="parts/index.html">
${thumbs.length === 0 ? '' : html`<span class="parts-link__thumbs">${thumbs.map((photo, index) => html`<img src="${snapshotRelative(photo.thumb)}" alt="${m.gallery.photoAlt(m.parts.subject, index + 1, data.parts?.photos.length ?? 0)}" loading="lazy" decoding="async" width="64" height="64">`)}</span>`}
<span>${m.parts.summary(data.parts.quantity, data.parts.lots)}</span>
<span class="visually-hidden">${m.parts.open}</span>
</a>
</section>`;
}

/** The landing page's HTML, from the data alone. */
export function renderLanding(data: PublicCatalogueData): string {
  const items = [...data.items].sort(bySetNumber);
  const grid =
    items.length === 0
      ? html`<p class="empty">${m.grid.nothing}</p>`
      : html`${filters(items)}
<ul class="grid" data-catalogue-grid>
${items.map(card)}</ul>
<p class="empty" data-catalogue-empty hidden>${m.grid.noMatch}</p>`;
  const body = html`${masthead()}
<main class="page">
${data.introText.trim() === '' ? '' : html`<section class="section" aria-label="${m.intro.label}">${prose(data.introText, 'prose')}</section>`}
${summarySection(summarize(data))}
<section class="section" aria-labelledby="sets-heading">
<h2 id="sets-heading" class="visually-hidden">${m.grid.heading}</h2>
${grid}
</section>
${partsSection(data)}
${data.contactText.trim() === '' ? '' : html`<section class="section" aria-labelledby="contact-heading"><h2 id="contact-heading">${m.contact.heading}</h2>${prose(data.contactText, 'prose')}</section>`}
</main>
${foot(publishedDate(data.publishedAt))}`;
  return toString(documentOf({ root: '', title: m.tagline, body }));
}
