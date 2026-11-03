/**
 * The imported lots as selling mode's parts download lists them (#211, [PUB-20], #5): each lot's
 * item type, item number, colour, condition and quantity, read from the stored `parts_lot` rows,
 * never from the uploaded file, which is never kept ([PARTS-1]). A stored lot holds no remark or
 * comment, so none can reach the download.
 *
 * The unit prices are private ([PARTS-4]): they are read only when the caller asks for them,
 * which the publish step's projection does only while the settings show market values
 * ([PUB-17], [PUB-18]). The file's currency comes with them, so the caller can tell whether the
 * prices are in the deployment's currency; it is never published.
 *
 * It reads in pages of `LOT_PAGE` rows, so a file of 50,000 lots stays under the Data API's
 * answer size, in a fixed order: by item type, item number, colour and condition.
 */
import { asc, desc, eq } from 'drizzle-orm';
import { partsImport, partsLot } from '../../db/schema/parts';
import type { Executor } from '../transaction';

/** One lot of the download: the fields `[PUB-20]` lists, and its unit price only when asked for. */
export interface DownloadLot {
  readonly itemType: string;
  readonly itemNo: string;
  readonly colorId: number;
  readonly condition: 'N' | 'U';
  readonly quantity: number;
  /** Present only when the prices were asked for; null when the file had none for the lot. */
  readonly unitPrice?: number | null;
}

export interface DownloadLots {
  readonly lots: readonly DownloadLot[];
  /** Present only when the prices were asked for: the file's currency, or null when it named none. */
  readonly currency?: string | null;
}

/** How many lots one query reads: well under the Data API's 1 MB answer. */
export const LOT_PAGE = 2_000;

/** The last import's lots, or null when nothing is imported. Unit prices only with `prices: true`. */
export async function readDownloadLots(executor: Executor, options: { readonly prices: boolean }): Promise<DownloadLots | null> {
  const [last] = await executor
    .select({ id: partsImport.id, ...(options.prices ? { currency: partsImport.currency } : {}) })
    .from(partsImport)
    .orderBy(desc(partsImport.importedAt))
    .limit(1);
  if (last === undefined) return null;
  const lots: DownloadLot[] = [];
  for (let offset = 0; ; offset += LOT_PAGE) {
    const page = await executor
      .select({
        itemType: partsLot.itemType,
        itemNo: partsLot.itemNo,
        colorId: partsLot.colorId,
        condition: partsLot.lotCondition,
        quantity: partsLot.lotQuantity,
        ...(options.prices ? { unitPrice: partsLot.unitPrice } : {}),
      })
      .from(partsLot)
      .where(eq(partsLot.importId, last.id))
      .orderBy(asc(partsLot.itemType), asc(partsLot.itemNo), asc(partsLot.colorId), asc(partsLot.lotCondition), asc(partsLot.id))
      .limit(LOT_PAGE)
      .offset(offset);
    lots.push(...page);
    if (page.length < LOT_PAGE) break;
  }
  return options.prices ? { lots, currency: (last as { currency?: string | null }).currency ?? null } : { lots };
}
