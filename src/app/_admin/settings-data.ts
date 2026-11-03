/**
 * `/admin/settings`'s data (brief #154, Issue B, [PUB-9], [PUB-15]): what the page shows, read
 * through the service core (`src/server/settings/`), and the texts' check, which is the service's
 * own schema, `SaveCatalogueTextsInput`, its issues mapped to the field they are about. The value
 * settings (#211, [PUB-17], [PUB-18]) are read from their form the same way, through
 * `SaveValueSettingsInput`. It reaches the database only through those functions (`AGENTS.md` §4).
 */
import type { z } from 'zod';
import { MAX_ASKING_PRICE, MAX_CATALOGUE_TEXT, SELLING_VALUE_DISPLAYS } from '../../db/schema/catalogue-settings';
import type { AdminContext } from '../../server/auth/admin-context';
import { readCatalogueAddress } from '../../server/settings/catalogue-address';
import { readCatalogueTexts, SaveCatalogueTextsInput } from '../../server/settings/catalogue-texts';
import { readValueSettings, SaveValueSettingsInput, type ValueSettings } from '../../server/settings/catalogue-values';

export type { ValueSettings } from '../../server/settings/catalogue-values';

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

export type AskingPriceField = keyof ValueSettings['askingPrices'];
export const ASKING_PRICE_FIELDS: readonly AskingPriceField[] = ['total', 'sealed', 'used', 'parts'];

/** What the value settings' Save says: saved, or which asking price is not an amount. */
export type SaveValuesResult =
  | { readonly status: 'saved'; readonly settings: ValueSettings }
  | { readonly status: 'invalid'; readonly problems: Readonly<Partial<Record<AskingPriceField, 'notAmount'>>> };

/**
 * An asking price as typed: empty is none, and a comma may be the decimal point, but only before
 * one or two digits, so `1,500`, which the app itself writes for fifteen hundred, is refused,
 * never read as 1.50. Anything else is NaN, which the schema refuses.
 */
function askingPrice(value: FormDataEntryValue | null): number | null {
  const text = typeof value === 'string' ? value.trim().replace(/\s/g, '') : '';
  if (text === '') return null;
  return /^\d+(?:[.,]\d{1,2})?$/.test(text) ? Number(text.replace(',', '.')) : Number.NaN;
}

/**
 * The value settings' form, checked by the very schema `saveValueSettings` parses with. The
 * display is sent only with selling mode on, so turning it on the first time makes it `ASKING`
 * unless the owner chose another, and turning it off keeps the one stored.
 */
export function valueSettingsFromForm(form: FormData): { readonly input: SaveValueSettingsInput } | Extract<SaveValuesResult, { status: 'invalid' }> {
  const sellingMode = form.get('sellingMode') === 'on';
  const display = SELLING_VALUE_DISPLAYS.find((known) => known === form.get('sellingValueDisplay'));
  const input: SaveValueSettingsInput = {
    showValues: form.get('showValues') === 'on',
    sellingMode,
    ...(sellingMode && display !== undefined ? { sellingValueDisplay: display } : {}),
    askingPrices: {
      total: askingPrice(form.get('askingTotal')),
      sealed: askingPrice(form.get('askingSealed')),
      used: askingPrice(form.get('askingUsed')),
      parts: askingPrice(form.get('askingParts')),
    },
  };
  const parsed = SaveValueSettingsInput.safeParse(input);
  if (parsed.success) return { input };
  const problems: Partial<Record<AskingPriceField, 'notAmount'>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[1];
    if (issue.path[0] !== 'askingPrices' || !ASKING_PRICE_FIELDS.some((known) => known === field)) {
      throw new Error(`The value settings were refused for a reason the page cannot show: ${issue.code}.`);
    }
    problems[field as AskingPriceField] = 'notAmount';
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
  /** Show values, selling mode, the display and the asking prices (#211). */
  readonly values: ValueSettings;
  /** The highest asking price the schema takes. */
  readonly maxAskingPrice: number;
}

/** What the settings page shows. */
export async function readCatalogueSettings(admin: AdminContext): Promise<CatalogueSettingsView> {
  const [texts, url, values] = await Promise.all([readCatalogueTexts(admin), readCatalogueAddress(admin), readValueSettings(admin)]);
  return { introText: texts.introText, contactText: texts.contactText, maxText: MAX_CATALOGUE_TEXT, url, values, maxAskingPrice: MAX_ASKING_PRICE };
}
