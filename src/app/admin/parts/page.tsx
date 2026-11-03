/**
 * `/admin/parts`: the loose parts ([PARTS-4], [PARTS-5], #161), behind the admin check
 * (`adminPage`, [AUTH-3]). The last import's summary (lots, parts, the total value when the file
 * had prices, and when it was imported), the file import with its replace warning, and up to 12
 * overview photos of the parts lot, queued on the device like any photo ([PHOTO-1]). Under the
 * summary, the parts' value by source and the lots, 100 to a page by the validated `?page=` query,
 * each with its unit price, value, source and date (#229, [VAL-6], [VAL-11]).
 */
import { adminPage } from '../../../server/auth/admin';
import { readPartsPage } from '../../../server/parts/parts';
import { readPartsValues } from '../../../server/valuation/refresh';
import { photoSettings } from '../../../server/photos/config';
import { MAX_PARTS_PHOTOS } from '../../../server/photos/photos';
import { CatalogueNotice } from '../../_admin/catalogue-notice';
import { Header, Page } from '../../_admin/chrome';
import { PartsImport } from '../../_admin/parts-import';
import { parseSkipped } from '../../_admin/parts-skipped';
import { PartsValues } from '../../_admin/parts-values';
import { parsePartsPage } from '../../_admin/value-data';
import { PhotoCapture, QueuePanel } from '../../_offline/client';
import { en } from '../../messages/en';
import { importParts, removePartsPhoto } from '../actions';

export const dynamic = 'force-dynamic';

/** The last import's skipped lots, carried across its reload in the query ([PARTS-1]). */
function SkippedNotice({ skipped }: { readonly skipped: { count: number; places: number[] } | null }) {
  if (skipped === null) return null;
  return (
    <p className="card" role="status">
      {en.parts.skipped(skipped.places, skipped.count)}
    </p>
  );
}

export default adminPage<{ readonly searchParams?: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ admin, searchParams }) => {
    const query = await searchParams;
    const [{ summary, photos }, values] = await Promise.all([readPartsPage(admin), readPartsValues(admin, { page: parsePartsPage(query?.page) })]);
    const m = en.parts;
    const full = photos.length >= MAX_PARTS_PHOTOS;
    return (
      <Page>
        <Header title={m.title} back={{ href: '/admin', label: en.form.back }} />
        <CatalogueNotice outcome={query?.catalogue} />
        <SkippedNotice skipped={parseSkipped(query)} />
        <QueuePanel />
        <section className="section card" aria-label={m.summaryLabel}>
          <h2>{m.summaryLabel}</h2>
          {summary === null ? (
            <p className="muted">{m.none}</p>
          ) : (
            <>
              <p>
                {m.lots(summary.lots)} · {m.quantity(summary.quantity)}
              </p>
              <p>{summary.totalValue === null ? m.noValue : m.value(summary.totalValue, summary.currency)}</p>
              <p className="muted">
                {m.importedAt(summary.importedAt)} · {m.format(summary.format)}
              </p>
            </>
          )}
        </section>
        {values === null ? null : <PartsValues values={values} />}
        <PartsImport currentLots={summary === null ? null : summary.lots} importParts={importParts} />
        <section className="section" aria-label={m.photosLabel}>
          <h2>{m.photosLabel}</h2>
          <p className="muted">{en.catalogueAfterDelete.deleteHint}</p>
          <p className="muted">{full ? m.photosFull(MAX_PARTS_PHOTOS) : m.photosHint(MAX_PARTS_PHOTOS)}</p>
          <PhotoCapture longestEdge={photoSettings().longestEdge} partsLot label={m.addPhotos} disabled={full} />
          {photos.length === 0 ? (
            <p className="muted">{m.photosEmpty}</p>
          ) : (
            <ul className="photo-grid">
              {photos.map((photo, index) => (
                <li key={photo.id} className="section">
                  <a href={photo.fullUrl} rel="noreferrer">
                    {/* A plain img: a presigned URL that Next.js's image optimizer must not fetch or cache. */}
                    <img src={photo.thumbnailUrl} alt={m.photoAlt(index + 1)} referrerPolicy="no-referrer" />
                  </a>
                  <form action={removePartsPhoto}>
                    <input type="hidden" name="photoId" value={photo.id} />
                    <button type="submit" className="button button--danger button--wide">
                      {m.deletePhoto}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Page>
    );
  },
  { path: '/admin/parts' },
);
