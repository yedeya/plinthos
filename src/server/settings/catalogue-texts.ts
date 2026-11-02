/**
 * The catalogue's two texts, the intro and the contact text, which the owner writes on
 * `/admin/settings` and a visitor reads on the landing page (#162, [PUB-9]).
 *
 * Both are plain text: the pages render them escaped, never as HTML (`src/server/publish/pages/`).
 * Saving one changes nothing public by itself; the texts reach the catalogue at the next publish,
 * which reads them through the public projection (`src/server/publish/projection.ts`, [PUB-5]).
 *
 * This module lives outside `src/server/publish/` because only the projection may reach the
 * database from there (`tests/server/publish/snapshot-writer.test.ts`, [PUB-5]).
 */
import { z } from 'zod';
import { catalogueSettings, MAX_CATALOGUE_TEXT } from '../../db/schema/catalogue-settings';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger } from '../logger';
import { db } from '../transaction';

/**
 * One text: line endings made `\n`, trimmed, at most `MAX_CATALOGUE_TEXT` characters, and no
 * control character but a newline or a tab, so what is saved is what a visitor reads.
 */
const CatalogueText = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .max(MAX_CATALOGUE_TEXT)
      // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
      .refine((text) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text), { message: 'plain text only: no control characters' }),
  );

export const SaveCatalogueTextsInput = z.strictObject({ introText: CatalogueText, contactText: CatalogueText });
export type SaveCatalogueTextsInput = z.input<typeof SaveCatalogueTextsInput>;

export interface CatalogueTexts {
  readonly introText: string;
  readonly contactText: string;
}

/** Saves both texts, as the validation left them, and answers with what was saved ([PUB-9]). */
export const saveCatalogueTexts = adminOperation(SaveCatalogueTextsInput, async (admin, input): Promise<CatalogueTexts> => {
  const [saved] = await db()
    .update(catalogueSettings)
    .set({ introText: input.introText, contactText: input.contactText })
    .returning({ introText: catalogueSettings.introText, contactText: catalogueSettings.contactText });
  if (saved === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  logger.info({ requestId: admin.requestId }, 'Saved the catalogue texts; they go out at the next publish.');
  return saved;
});

/** The texts as saved, for the settings page. */
export async function readCatalogueTexts(admin: AdminContext): Promise<CatalogueTexts> {
  assertAdmin(admin);
  const [row] = await db().select({ introText: catalogueSettings.introText, contactText: catalogueSettings.contactText }).from(catalogueSettings);
  if (row === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  return row;
}
