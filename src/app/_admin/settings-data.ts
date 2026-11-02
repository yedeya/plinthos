/**
 * `/admin/settings`'s server side (brief #154, Issue B, [PUB-9], [PUB-15]): the two service
 * functions the page's actions call, and the page's read of the current settings.
 *
 * STAND-IN: #162 (Issue A) builds `saveCatalogueTexts` and `rotateCatalogueToken` in
 * `src/server/publish/`, with the `intro_text` and `contact_text` columns. Until it merges, this
 * module holds stand-ins of exactly their signatures, which validate their input and then refuse,
 * so nothing here can pretend a text was saved or a link rotated. When #162 lands, the two
 * stand-ins become re-exports of its functions, and `readCatalogueSettings` reads the two texts
 * from their columns. Every STAND-IN line below is one of those changes.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { assertAdmin, type AdminContext } from '../../server/auth/admin-context';
import { database } from '../../server/database';
import { catalogueSettings, CATALOGUE_SETTINGS_ID } from '../../db/schema/catalogue-settings';
import { snapshotResource } from '../../server/publish/aws';
import { snapshotPath } from '../../server/publish/snapshot';
import { isCatalogueToken } from '../../server/publish/token';

/** The longest intro or contact text, in characters ([PUB-9]). */
export const CATALOGUE_TEXT_MAX = 2000;

export const CatalogueTextsInput = z
  .object({
    introText: z.string().max(CATALOGUE_TEXT_MAX),
    contactText: z.string().max(CATALOGUE_TEXT_MAX),
  })
  .strict();

/** What a rotation answers: the new address, or a failure that says whether the old link still serves ([OPS-6]). */
export type RotateResult =
  | { readonly status: 'rotated'; readonly url: string }
  | { readonly status: 'failed'; readonly requestId: string; readonly previousKept: boolean };

/** What the texts' Save says: saved, or which text is too long ([PUB-9]). */
export type SaveTextsResult = { readonly status: 'saved' } | { readonly status: 'invalid'; readonly fields: readonly ('introText' | 'contactText')[] };

export class StandInError extends Error {
  override name = 'StandInError';
}

/** STAND-IN for #162's `saveCatalogueTexts(admin, { introText, contactText })`. */
export async function saveCatalogueTexts(admin: AdminContext, input: z.input<typeof CatalogueTextsInput>): Promise<void> {
  assertAdmin(admin);
  CatalogueTextsInput.parse(input);
  throw new StandInError('STAND-IN: saving the catalogue texts arrives with #162.');
}

/** STAND-IN for #162's `rotateCatalogueToken(admin)`. */
export async function rotateCatalogueToken(admin: AdminContext): Promise<RotateResult> {
  assertAdmin(admin);
  throw new StandInError('STAND-IN: rotating the catalogue link arrives with #162.');
}

export interface CatalogueSettingsView {
  readonly introText: string;
  readonly contactText: string;
  /** The catalogue's address, only for the admin; null before the first publish. */
  readonly url: string | null;
}

/** The settings the page shows: the two texts, and the catalogue's address. */
export async function readCatalogueSettings(admin: AdminContext): Promise<CatalogueSettingsView> {
  assertAdmin(admin);
  const [row] = await database().select({ publicToken: catalogueSettings.publicToken }).from(catalogueSettings).where(eq(catalogueSettings.id, CATALOGUE_SETTINGS_ID));
  const token = row?.publicToken ?? null;
  return {
    introText: '', // STAND-IN: #162's `catalogue_settings.intro_text`.
    contactText: '', // STAND-IN: #162's `catalogue_settings.contact_text`.
    url: isCatalogueToken(token) ? `${publicOrigin()}${snapshotPath(token)}` : null,
  };
}

function publicOrigin(): string {
  return snapshotResource().url.replace(/\/+$/, '');
}
