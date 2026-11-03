'use server';

/**
 * The admin's Server Actions. Each is wrapped in `adminAction`, so a call without the signed-in
 * admin's session, or from another origin, is refused before it runs ([AUTH-3], [AUTH-5]).
 */
import { redirect } from 'next/navigation';
import { adminAction } from '../../server/auth/admin';
import { importPartsFile, type ImportPartsResult } from '../../server/parts/parts';
import { deletePhoto } from '../../server/photos/photos';
import { publishCatalogue, republishCatalogue, rotateCatalogueToken, type PublishResult, type RotateResult } from '../../server/publish/publish';
import type { AdminContext } from '../../server/auth/admin-context';
import { saveCatalogueTexts } from '../../server/settings/catalogue-texts';
import { saveValueSettings } from '../../server/settings/catalogue-values';
import { catalogueQuery } from '../_admin/catalogue-notice';
import { checkCatalogueTexts, valueSettingsFromForm, type SaveTextsResult, type SaveValuesResult } from '../_admin/settings-data';

/**
 * Deletes a photo and, when that removed one, republishes the catalogue so it leaves the public
 * site too (#187, [PUB-16]); answers the query the page's redirect carries. A failed republish
 * never undoes the delete: the page then asks the owner to press Publish.
 */
async function deletePhotoAndRepublish(admin: AdminContext, form: FormData): Promise<string> {
  const { deleted } = await deletePhoto(admin, { photoId: String(form.get('photoId') ?? '') });
  if (!deleted) return '';
  return catalogueQuery((await republishCatalogue(admin)).catalogue);
}

/** The Publish button: publishes the catalogue and answers with the outcome the form shows ([OPS-6]). */
export const publish = adminAction(async (admin): Promise<PublishResult> => publishCatalogue(admin, {}), { name: 'publish' });

/**
 * A photo's Delete button on `/admin/photos`: the same `deletePhoto` the offline-sync endpoint replays
 * (`AGENTS.md` §4), and the republish that follows it (#187), then back to `/admin/photos`, which lists
 * what is left and says whether the public catalogue was updated.
 */
export const removePhoto = adminAction(
  async (admin, form: FormData): Promise<void> => {
    redirect(`/admin/photos${await deletePhotoAndRepublish(admin, form)}`);
  },
  { name: 'removePhoto' },
);

/**
 * The parts file's import on `/admin/parts`, once the page has uploaded it into the imports
 * prefix: the same `importPartsFile` any later tool calls (`AGENTS.md` §4, [PARTS-3]). It answers
 * the outcome, which the page shows; the upload is deleted whatever it comes to ([PARTS-2]).
 */
export const importParts = adminAction(async (admin, uploadKey: string): Promise<ImportPartsResult> => importPartsFile(admin, { uploadKey }), {
  name: 'importParts',
});

/** An overview photo's Delete button on `/admin/parts`: `deletePhoto` and the republish (#187), then back to `/admin/parts`. */
export const removePartsPhoto = adminAction(
  async (admin, form: FormData): Promise<void> => {
    redirect(`/admin/parts${await deletePhotoAndRepublish(admin, form)}`);
  },
  { name: 'removePartsPhoto' },
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

/**
 * The value settings' Save on `/admin/settings` (#211, [PUB-17], [PUB-18]): Show values, selling
 * mode, the display and the asking prices, checked by the service's own schema, then saved
 * through the one service function. They reach the catalogue at the next publish.
 */
export const saveValues = adminAction(
  async (admin, _previous: SaveValuesResult | null, form: FormData): Promise<SaveValuesResult> => {
    const read = valueSettingsFromForm(form);
    if (!('input' in read)) return read;
    return { status: 'saved', settings: await saveValueSettings(admin, read.input) };
  },
  { name: 'saveValues' },
);

/** Rotate catalogue link on `/admin/settings`, after the page's confirmation ([PUB-15]). */
export const rotateLink = adminAction(async (admin): Promise<RotateResult> => rotateCatalogueToken(admin), { name: 'rotateLink' });
