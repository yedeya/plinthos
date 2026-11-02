/**
 * The gallery on a set page and the parts page (`docs/design/catalogue.md` § Components): the
 * owner's photos, then the stock image, as a horizontal scroll-snap track with a strip of
 * thumbnails that link to each slide, so it works without the script. A tap on a slide opens its
 * full size. Every slide after the first loads lazily, and every image has alt text ([PUB-11]).
 * The script adds arrow buttons on a wide screen.
 */
import type { PublicPhoto } from '../catalogue-data';
import { html, httpsUrl, snapshotRelative, type Markup } from './html';
import type { Root } from './layout';
import { catalogueMessages as m } from './messages';

interface Slide {
  readonly full: string;
  readonly thumb: string;
  readonly alt: string;
  readonly external: boolean;
}

export function gallery({ root, subject, photos, stock }: { readonly root: Root; readonly subject: string; readonly photos: readonly PublicPhoto[]; readonly stock?: { readonly url: string | null; readonly name: string } }): Markup {
  const slides: Slide[] = photos.map((photo, index) => ({
    full: root + snapshotRelative(photo.full),
    thumb: root + snapshotRelative(photo.thumb),
    alt: m.gallery.photoAlt(subject, index + 1, photos.length),
    external: false,
  }));
  const stockUrl = httpsUrl(stock?.url ?? null);
  if (stock !== undefined && stockUrl !== null) slides.push({ full: stockUrl, thumb: stockUrl, alt: m.gallery.stockAlt(stock.name), external: true });
  if (slides.length === 0) return html`<p class="muted">${m.gallery.none}</p>`;

  const noReferrer = (slide: Slide) => (slide.external ? html` referrerpolicy="no-referrer"` : '');
  return html`<section class="gallery" aria-label="${m.gallery.label}" data-gallery>
<ul class="gallery__track" data-gallery-track tabindex="0" aria-label="${m.gallery.label}">
${slides.map(
  (slide, index) =>
    html`<li class="gallery__slide" id="photo-${index + 1}"><a href="${slide.full}"${slide.external ? html` rel="noreferrer"` : ''}><img src="${slide.full}" alt="${slide.alt}"${index === 0 ? '' : html` loading="lazy"`} decoding="async"${noReferrer(slide)}></a></li>
`,
)}</ul>
${
  slides.length > 1
    ? html`<div class="gallery__arrows" data-gallery-arrows hidden><button type="button" class="gallery__arrow" data-gallery-prev aria-label="${m.gallery.previous}">‹</button><button type="button" class="gallery__arrow" data-gallery-next aria-label="${m.gallery.next}">›</button></div>
<ol class="gallery__thumbs" aria-label="${m.gallery.thumbs}">
${slides.map((slide, index) => html`<li><a href="#photo-${index + 1}"><img src="${slide.thumb}" alt="${m.gallery.show(index + 1)}" loading="lazy" decoding="async" width="64" height="64"${noReferrer(slide)}></a></li>
`)}</ol>`
    : ''
}
</section>`;
}
