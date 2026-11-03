/**
 * What the catalogue shows of the values (#211, [PUB-17], [PUB-18]): **Show values**, **Selling
 * mode**, the value display and the four asking prices, which the owner sets on
 * `/admin/settings`. All of them are private (`src/db/schema/classification.ts`): the publish
 * step's projection reads them and publishes only their effect, at the next publish.
 *
 * The display is `ASKING` the first time selling mode is turned on, unless the owner chose
 * another (`HANDOVER.md` §10.9). An asking price is kept while selling mode is off, and is
 * published only while selling mode is on and the display shows asking prices.
 *
 * It lives outside `src/server/publish/`, as the texts do, because only the projection may reach
 * the database from there ([PUB-5]).
 */
import { z } from 'zod';
import { catalogueSettings, MAX_ASKING_PRICE, SELLING_VALUE_DISPLAYS, type SellingValueDisplay } from '../../db/schema/catalogue-settings';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger } from '../logger';
import { db } from '../transaction';

/** An asking price: none, or an amount from 0 to `MAX_ASKING_PRICE` in whole cents. */
const AskingPrice = z
  .number()
  .finite()
  .min(0)
  .max(MAX_ASKING_PRICE)
  .refine((amount) => Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6, { message: 'at most two decimals' })
  .nullable();

export const SaveValueSettingsInput = z.strictObject({
  showValues: z.boolean(),
  sellingMode: z.boolean(),
  /** Left out to keep the stored display, or `ASKING` when selling mode is first turned on. */
  sellingValueDisplay: z.enum(SELLING_VALUE_DISPLAYS).optional(),
  askingPrices: z.strictObject({ total: AskingPrice, sealed: AskingPrice, used: AskingPrice, parts: AskingPrice }),
});
export type SaveValueSettingsInput = z.input<typeof SaveValueSettingsInput>;

export interface AskingPrices {
  readonly total: number | null;
  readonly sealed: number | null;
  readonly used: number | null;
  readonly parts: number | null;
}

export interface ValueSettings {
  readonly showValues: boolean;
  readonly sellingMode: boolean;
  /** Null until selling mode is first turned on. */
  readonly sellingValueDisplay: SellingValueDisplay | null;
  readonly askingPrices: AskingPrices;
}

const columns = {
  showValues: catalogueSettings.showValues,
  sellingMode: catalogueSettings.sellingMode,
  sellingValueDisplay: catalogueSettings.sellingValueDisplay,
  total: catalogueSettings.askingPriceTotal,
  sealed: catalogueSettings.askingPriceSealed,
  used: catalogueSettings.askingPriceUsed,
  parts: catalogueSettings.askingPriceParts,
};

interface Row {
  readonly showValues: boolean;
  readonly sellingMode: boolean;
  readonly sellingValueDisplay: string | null;
  readonly total: number | null;
  readonly sealed: number | null;
  readonly used: number | null;
  readonly parts: number | null;
}

function settingsOf(row: Row | undefined): ValueSettings {
  if (row === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  return {
    showValues: row.showValues,
    sellingMode: row.sellingMode,
    sellingValueDisplay: SELLING_VALUE_DISPLAYS.find((display) => display === row.sellingValueDisplay) ?? null,
    askingPrices: { total: row.total, sealed: row.sealed, used: row.used, parts: row.parts },
  };
}

/** Saves the value settings and answers what was saved; they reach the catalogue at the next publish. */
export const saveValueSettings = adminOperation(SaveValueSettingsInput, async (admin, input): Promise<ValueSettings> => {
  const [stored] = await db().select({ sellingValueDisplay: catalogueSettings.sellingValueDisplay }).from(catalogueSettings);
  if (stored === undefined) throw new Error('catalogue_settings has no row: the seeding migration has not run.');
  const kept = SELLING_VALUE_DISPLAYS.find((display) => display === stored.sellingValueDisplay) ?? null;
  // [PUB-18] ASKING is the display the first time selling mode is turned on.
  const display = input.sellingValueDisplay ?? kept ?? (input.sellingMode ? 'ASKING' : null);
  const [saved] = await db()
    .update(catalogueSettings)
    .set({
      showValues: input.showValues,
      sellingMode: input.sellingMode,
      sellingValueDisplay: display,
      askingPriceTotal: input.askingPrices.total,
      askingPriceSealed: input.askingPrices.sealed,
      askingPriceUsed: input.askingPrices.used,
      askingPriceParts: input.askingPrices.parts,
    })
    .returning(columns);
  // Never an amount: the log says what changed, not the owner's prices.
  logger.info(
    { requestId: admin.requestId, showValues: input.showValues, sellingMode: input.sellingMode, sellingValueDisplay: display },
    'Saved the value settings; they go out at the next publish.',
  );
  return settingsOf(saved);
});

/** The value settings as saved, for the settings page. */
export async function readValueSettings(admin: AdminContext): Promise<ValueSettings> {
  assertAdmin(admin);
  const [row] = await db().select(columns).from(catalogueSettings);
  return settingsOf(row);
}
