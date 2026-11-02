'use server';

/**
 * The admin's Server Actions. Each is wrapped in `adminAction`, so a call without the signed-in
 * admin's session, or from another origin, is refused before it runs ([AUTH-3], [AUTH-5]).
 */
import { redirect } from 'next/navigation';
import { adminAction } from '../../server/auth/admin';
import { deletePhoto } from '../../server/photos/photos';
import { publishCatalogue, type PublishResult } from '../../server/publish/publish';

/** The Publish button: publishes the catalogue and answers with the outcome the form shows ([OPS-6]). */
export const publish = adminAction(async (admin): Promise<PublishResult> => publishCatalogue(admin, {}), { name: 'publish' });

/**
 * A photo's Delete button on `/admin`: the same `deletePhoto` the offline-sync endpoint replays
 * (`AGENTS.md` §4), then back to `/admin`, which lists what is left.
 */
export const removePhoto = adminAction(
  async (admin, form: FormData): Promise<void> => {
    await deletePhoto(admin, { photoId: String(form.get('photoId') ?? '') });
    redirect('/admin');
  },
  { name: 'removePhoto' },
);
