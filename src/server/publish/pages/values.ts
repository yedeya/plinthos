/**
 * The values and asking prices on the catalogue's pages (#211, [PUB-17] to [PUB-19]). Each
 * renders only what the data holds: the projection leaves out every field the settings hide
 * (`../catalogue-data.ts`), so a page can show no value the settings don't. Each also checks the
 * type of what it renders, so a field that is not an amount renders nothing.
 */
import type { PublicCatalogueData, PublicItem, PublicSegment } from '../catalogue-data';
import { html, type Markup } from './html';
import { catalogueMessages as m, money, publishedDate } from './messages';

const CURRENCY = /^[A-Z]{3}$/;

/** A finite, non-negative number: the only amount a page renders. */
export function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** The data's currency, when it holds one a page can format amounts in. */
export function currencyOf(data: PublicCatalogueData): string | null {
  return typeof data.valueCurrency === 'string' && CURRENCY.test(data.valueCurrency) ? data.valueCurrency : null;
}

/** An amount as text, or null when the data holds no amount or no currency for it. */
export function amountText(data: PublicCatalogueData, amount: unknown): string | null {
  const currency = currencyOf(data);
  return currency !== null && isAmount(amount) ? money(amount, currency) : null;
}

/** An item's value, when the data holds one: the amount, and the line under it. */
export function itemValue(data: PublicCatalogueData, item: PublicItem): { readonly amount: string; readonly estimated: string } | null {
  const amount = amountText(data, item.value);
  if (amount === null) return null;
  const date = typeof item.asOf === 'string' ? publishedDate(item.asOf) : '';
  return { amount, estimated: date === '' ? '' : m.values.estimated(date) };
}

/** The items of one split view, by the segment the data gives each, in selling mode alone ([PUB-19]). */
export function itemsIn(data: PublicCatalogueData, segment: PublicSegment): readonly PublicItem[] {
  return data.items.filter((item) => item.segment === segment);
}

/** Whether every item shown with a value can be sorted by it: one value at least. */
export function sortsByValue(data: PublicCatalogueData, items: readonly PublicItem[]): boolean {
  return currencyOf(data) !== null && items.some((item) => isAmount(item.value));
}

const SEGMENTS: readonly PublicSegment[] = ['sealed', 'used', 'parts'];

/** The landing's lines of totals and asking prices, each only when the data holds them ([PUB-17], [PUB-18]). */
export function landingValues(data: PublicCatalogueData): Markup {
  const totals = data.totals;
  const asking = data.asking;
  const line = (label: string, all: unknown, parts: Record<PublicSegment, unknown>, className: string) => {
    const pieces = [
      ...(amountText(data, all) === null ? [] : [`${label} ${amountText(data, all) ?? ''}`]),
      ...SEGMENTS.flatMap((segment) => {
        const text = amountText(data, parts[segment]);
        return text === null ? [] : [m.values.part(m.values.segment[segment], text)];
      }),
    ];
    return pieces.length === 0 ? '' : html`<p class="${className}">${pieces.join(' · ')}</p>`;
  };
  return html`${totals === undefined ? '' : line(m.values.totals, totals.all, { sealed: totals.sealed, used: totals.used, parts: totals.parts }, 'summary__values')}
${asking === undefined ? '' : line(m.values.asking, asking.total, { sealed: asking.sealed, used: asking.used, parts: asking.parts }, 'summary__asking')}`;
}

/** A split view's subtotal: the segment's estimated value and its asking price, each only when held ([PUB-19]). */
export function segmentSubtotal(data: PublicCatalogueData, segment: PublicSegment): Markup {
  const value = amountText(data, data.totals?.[segment]);
  const asking = amountText(data, data.asking?.[segment]);
  if (value === null && asking === null) return html``;
  return html`<p class="summary__values" data-subtotal>${[value === null ? null : `${m.values.totals} ${value}`, asking === null ? null : `${m.values.asking} ${asking}`].filter((part) => part !== null).join(' · ')}</p>`;
}

/** The split views the data offers, in order, each only in selling mode ([PUB-19]). */
export function segmentsOf(data: PublicCatalogueData): readonly PublicSegment[] {
  const offered = Array.isArray(data.segments) ? data.segments : [];
  return SEGMENTS.filter((segment) => offered.includes(segment));
}

/** The links to the split views, from the landing ([PUB-19]). */
export function segmentLinks(data: PublicCatalogueData): Markup {
  const segments = segmentsOf(data);
  if (segments.length === 0) return html``;
  return html`<nav class="segments" aria-label="${m.segments.label}">
${segments.map((segment) => html`<a class="segments__link" href="${segment}/index.html">${m.segments.link[segment]}</a>
`)}</nav>`;
}

/** Whether the data holds a parts download: selling mode, and lots imported ([PUB-20]). */
export function hasPartsDownload(data: PublicCatalogueData): boolean {
  return Array.isArray(data.parts?.list) && (data.parts?.list.length ?? 0) > 0;
}

/** The parts download's links, from a page at `root` ([PUB-20]). */
export function downloadLinks(data: PublicCatalogueData, root: '' | '../'): Markup {
  if (!hasPartsDownload(data)) return html``;
  return html`<section class="section downloads" aria-labelledby="download-heading">
<h2 id="download-heading">${m.download.heading}</h2>
<p class="muted">${m.download.hint}</p>
<p class="downloads__links"><a href="${root}parts.csv" download>${m.download.csv}</a> <a href="${root}parts.xml" download>${m.download.xml}</a></p>
</section>`;
}
