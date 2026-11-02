/**
 * `/admin`: the signed-in home. Behind the admin check (`adminPage`, [AUTH-3]): the Publish button
 * (#19), the way to add photos and the stored photos' thumbnails, each through a presigned URL
 * and with a Delete button (#22, [PHOTO-6]), the device's offline queue ([SYNC-8]) and the way
 * out, which clears that queue and the service worker's caches after a warning ([SYNC-9]).
 */
import { adminPage } from '../../server/auth/admin';
import { listPhotos } from '../../server/photos/photos';
import { photoSettings } from '../../server/photos/config';
import { PhotoCapture, QueuePanel, SignOutButton } from '../_offline/client';
import { PublishForm } from '../publish-form';
import { publish, removePhoto } from './actions';

export const dynamic = 'force-dynamic';

export default adminPage(
  async ({ admin }) => {
    const photos = await listPhotos(admin);
    return (
      <main>
        <h1>Plinthos</h1>
        <p>You are signed in. There is nothing to manage yet but the public catalogue and your photos.</p>
        <PublishForm action={publish} />
        <PhotoCapture longestEdge={photoSettings().longestEdge} />
        <section aria-label="Photos">
          <h2>Photos</h2>
          {photos.length === 0 ? (
            <p>No photos are stored yet. A photo you add appears here once it has synced.</p>
          ) : (
            <ul>
              {photos.map((photo) => (
                <li key={photo.id}>
                  <a href={photo.fullUrl} rel="noreferrer">
                    {/* A plain img: a presigned URL that Next.js's image optimizer must not fetch or cache. */}
                    <img src={photo.thumbnailUrl} alt={`Photo added ${photo.createdAt}`} referrerPolicy="no-referrer" />
                  </a>
                  <form action={removePhoto}>
                    <input type="hidden" name="photoId" value={photo.id} />
                    <button type="submit">Delete</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
        <QueuePanel />
        <SignOutButton />
      </main>
    );
  },
  { path: '/admin' },
);
