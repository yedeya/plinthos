'use server';

/**
 * The admin's Server Actions. Each is wrapped in `adminAction`, so a call without the signed-in
 * admin's session, or from another origin, is refused before it runs ([AUTH-3], [AUTH-5]).
 */
import { redirect } from 'next/navigation';
import { adminAction } from '../../server/auth/admin';
import { deletePhoto } from '../../server/photos/photos';
import { publishCatalogue, rotateCatalogueToken, type PublishResult, type RotateResult } from '../../server/publish/publish';
import { saveCatalogueTexts } from '../../server/settings/catalogue-texts';
import { checkCatalogueTexts, type SaveTextsResult } from '../_admin/settings-data';

/** The Publish button: publishes the catalogue and answers with the outcome the form shows ([OPS-6]). */
export const publish = adminAction(async (admin): Promise<PublishResult> => publishCatalogue(admin, {}), { name: 'publish' });

/**
 * A photo's Delete button on `/admin/photos`: the same `deletePhoto` the offline-sync endpoint replays
 * (`AGENTS.md` §4), then back to `/admin/photos`, which lists what is left.
 */
export const removePhoto = adminAction(
  async (admin, form: FormData): Promise<void> => {
    await deletePhoto(admin, { photoId: String(form.get('photoId') ?? '') });
    redirect('/admin/photos');
  },
  { name: 'removePhoto' },
);

/**
 * The texts' Save on `/admin/settings` ([PUB-9]): checked by the service's own schema first, so a
 * refused text is answered on its field rather than as a failed request, then saved through the
 * one service function.
 */
export const saveTexts = adminAction(
  async (admin, _previous: SaveTextsResult | null, form: FormData): Promise<SaveTextsResult> => {
    const input = { introText: String(form.get('introText') ?? ''), contactText: String(form.get('contactText') ?? '') };
    const refused = checkCatalogueTexts(input);
    if (refused !== null) return refused;
    await saveCatalogueTexts(admin, input);
    return { status: 'saved' };
  },
  { name: 'saveTexts' },
);

/** Rotate catalogue link on `/admin/settings`, after the page's confirmation ([PUB-15]). */
export const rotateLink = adminAction(async (admin): Promise<RotateResult> => rotateCatalogueToken(admin), { name: 'rotateLink' });
