/**
 * `/admin/settings`'s data (brief #154, Issue B, [PUB-9], [PUB-15]): what the page shows, read
 * through the service core (`src/server/settings/`), and the texts' check, which is the service's
 * own schema, `SaveCatalogueTextsInput`, its issues mapped to the field they are about. It reaches
 * the database only through those functions (`AGENTS.md` §4).
 */
import type { z } from 'zod';
import { MAX_CATALOGUE_TEXT } from '../../db/schema/catalogue-settings';
import type { AdminContext } from '../../server/auth/admin-context';
import { readCatalogueAddress } from '../../server/settings/catalogue-address';
import { readCatalogueTexts, SaveCatalogueTextsInput } from '../../server/settings/catalogue-texts';

export type { RotateResult } from '../../server/publish/publish';

export type CatalogueTextField = 'introText' | 'contactText';

/** Why a text was refused: too long, or holding a control character. */
export type CatalogueTextProblem = 'tooLong' | 'notPlain';

/** What the texts' Save says: saved, or what is wrong with which text ([PUB-9]). */
export type SaveTextsResult =
  | { readonly status: 'saved' }
  | { readonly status: 'invalid'; readonly problems: Readonly<Partial<Record<CatalogueTextField, CatalogueTextProblem>>> };

/**
 * The texts checked by the very schema `saveCatalogueTexts` parses with, so the page refuses
 * exactly what the service would: null when they pass, else each refused field's problem.
 */
export function checkCatalogueTexts(input: z.input<typeof SaveCatalogueTextsInput>): SaveTextsResult | null {
  const parsed = SaveCatalogueTextsInput.safeParse(input);
  if (parsed.success) return null;
  const problems: Partial<Record<CatalogueTextField, CatalogueTextProblem>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field !== 'introText' && field !== 'contactText') throw new Error(`The catalogue texts were refused for a reason the page cannot show: ${issue.code}.`);
    problems[field] ??= issue.code === 'too_big' ? 'tooLong' : 'notPlain';
  }
  return { status: 'invalid', problems };
}

export interface CatalogueSettingsView {
  readonly introText: string;
  readonly contactText: string;
  /** The longest text, in characters: the schema's one limit. */
  readonly maxText: number;
  /** The catalogue's address, only for the admin; null before the first publish. */
  readonly url: string | null;
}

/** What the settings page shows. */
export async function readCatalogueSettings(admin: AdminContext): Promise<CatalogueSettingsView> {
  const [texts, url] = await Promise.all([readCatalogueTexts(admin), readCatalogueAddress(admin)]);
  return { introText: texts.introText, contactText: texts.contactText, maxText: MAX_CATALOGUE_TEXT, url };
}
