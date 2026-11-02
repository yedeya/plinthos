/**
 * `/admin/photos`: the stored photos, behind the admin check (`adminPage`, [AUTH-3]). Each
 * thumbnail comes through a presigned URL, with a Delete button (#22, [PHOTO-6]), and photos can
 * still be added here on their own, queued on the device like an item's ([PHOTO-1]). It moved
 * here from `/admin` when the items took the home (#128).
 */
import { adminPage } from '../../../server/auth/admin';
import { photoSettings } from '../../../server/photos/config';
import { listPhotos } from '../../../server/photos/photos';
import { Header, Page } from '../../_admin/chrome';
import { PhotoCapture, QueuePanel } from '../../_offline/client';
import { en } from '../../messages/en';
import { removePhoto } from '../actions';

export const dynamic = 'force-dynamic';

export default adminPage(
  async ({ admin }) => {
    const photos = await listPhotos(admin);
    return (
      <Page>
        <Header title={en.photosPage.title} back={{ href: '/admin', label: en.form.back }} />
        <QueuePanel />
        <PhotoCapture longestEdge={photoSettings().longestEdge} />
        <section className="section" aria-label={en.photosPage.stored}>
          <h2>{en.photosPage.stored}</h2>
          {photos.length === 0 ? (
            <p className="muted">{en.photosPage.empty}</p>
          ) : (
            <ul className="photo-grid">
              {photos.map((photo) => (
                <li key={photo.id} className="section">
                  <a href={photo.fullUrl} rel="noreferrer">
                    {/* A plain img: a presigned URL that Next.js's image optimizer must not fetch or cache. */}
                    <img src={photo.thumbnailUrl} alt={en.photosPage.alt(photo.createdAt)} referrerPolicy="no-referrer" />
                  </a>
                  <form action={removePhoto}>
                    <input type="hidden" name="photoId" value={photo.id} />
                    <button type="submit" className="button button--danger button--wide">
                      {en.photosPage.delete}
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
  { path: '/admin/photos' },
);
