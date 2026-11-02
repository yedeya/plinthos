'use server';

/**
 * The admin's Server Actions. Each is wrapped in `adminAction`, so a call without the signed-in
 * admin's session, or from another origin, is refused before it runs ([AUTH-3], [AUTH-5]).
 */
import { redirect } from 'next/navigation';
import { adminAction } from '../../server/auth/admin';
import { deletePhoto } from '../../server/photos/photos';
import { publishCatalogue, type PublishResult } from '../../server/publish/publish';
import { CatalogueTextsInput, rotateCatalogueToken, saveCatalogueTexts, type RotateResult, type SaveTextsResult } from '../_admin/settings-data';

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
 * The texts' Save on `/admin/settings` ([PUB-9]): the intro and the contact text through the one
 * service function. A text over the limit is answered as invalid, naming the field, and nothing is saved.
 */
export const saveTexts = adminAction(
  async (admin, _previous: SaveTextsResult | null, form: FormData): Promise<SaveTextsResult> => {
    const input = { introText: String(form.get('introText') ?? ''), contactText: String(form.get('contactText') ?? '') };
    const parsed = CatalogueTextsInput.safeParse(input);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter((field) => field === 'introText' || field === 'contactText'))];
      return { status: 'invalid', fields };
    }
    await saveCatalogueTexts(admin, parsed.data);
    return { status: 'saved' };
  },
  { name: 'saveTexts' },
);

/** Rotate catalogue link on `/admin/settings`, after the page's confirmation ([PUB-15]). */
export const rotateLink = adminAction(async (admin): Promise<RotateResult> => rotateCatalogueToken(admin), { name: 'rotateLink' });
