/**
 * The imported lots as selling mode's parts download lists them (#211, [PUB-20], #5): each lot's
 * item type, item number, colour, condition and quantity, read from the stored `parts_lot` rows,
 * never from the uploaded file, which is never kept ([PARTS-1]). A stored lot holds no remark or
 * comment, so none can reach the download.
 *
 * It reads no unit price, no value and no currency (#229): a lot's price in the download is its
 * value by `[VAL-6]`, which only `readCollectionValues` answers (`../valuation/values.ts`), by the
 * lot's id. The id is read only to join that value; it is private and the projection never
 * publishes it.
 *
 * It reads in pages of `LOT_PAGE` rows, so a file of 50,000 lots stays under the Data API's
 * answer size, in a fixed order: by item type, item number, colour and condition.
 */
import { asc, desc, eq } from 'drizzle-orm';
import { partsImport, partsLot } from '../../db/schema/parts';
import type { Executor } from '../transaction';

/** One lot of the download: the fields `[PUB-20]` lists, and its private id, to join its value. */
export interface DownloadLot {
  readonly id: string;
  readonly itemType: string;
  readonly itemNo: string;
  readonly colorId: number;
  readonly condition: 'N' | 'U';
  readonly quantity: number;
}

export interface DownloadLots {
  readonly lots: readonly DownloadLot[];
}

/** How many lots one query reads: well under the Data API's 1 MB answer. */
export const LOT_PAGE = 2_000;

/** The last import's lots, or null when nothing is imported. */
export async function readDownloadLots(executor: Executor): Promise<DownloadLots | null> {
  const [last] = await executor.select({ id: partsImport.id }).from(partsImport).orderBy(desc(partsImport.importedAt)).limit(1);
  if (last === undefined) return null;
  const lots: DownloadLot[] = [];
  for (let offset = 0; ; offset += LOT_PAGE) {
    const page = await executor
      .select({
        id: partsLot.id,
        itemType: partsLot.itemType,
        itemNo: partsLot.itemNo,
        colorId: partsLot.colorId,
        condition: partsLot.lotCondition,
        quantity: partsLot.lotQuantity,
      })
      .from(partsLot)
      .where(eq(partsLot.importId, last.id))
      .orderBy(asc(partsLot.itemType), asc(partsLot.itemNo), asc(partsLot.colorId), asc(partsLot.lotCondition), asc(partsLot.id))
      .limit(LOT_PAGE)
      .offset(offset);
    lots.push(...page);
    if (page.length < LOT_PAGE) break;
  }
  return { lots };
}
