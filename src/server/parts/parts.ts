/**
 * The parts import's service functions (#161, [PARTS-2] to [PARTS-5], `AGENTS.md` §4).
 *
 * A parts file reaches the server the way a photo does ([PHOTO-7]):
 *
 * 1. `presignPartsUpload` makes a random key under the photo bucket's private `imports/` prefix
 *    and presigns a POST of it that S3 refuses past the size cap or after 10 minutes. The upload
 *    goes straight to S3, because a 50,000-part file can exceed Lambda's 6 MB request limit
 *    (brief #153, decision 2).
 * 2. `importPartsFile` reads the object, refusing one over the cap, parses it (`./parse.ts`), and
 *    **replaces** the inventory in one transaction: it deletes every lot and the last import, and
 *    inserts the file's lots with a new `parts_import` row ([PARTS-3]). A refused or failed import
 *    changes nothing. Whatever it comes to, it then deletes the upload: the file is never kept as
 *    it arrived ([PARTS-2]).
 *
 * The import needs the network, since the server parses the file; the overview photos queue
 * offline like any photo, through `registerPhoto` with `partsLot: true` (`../photos/photos.ts`).
 *
 * `parts.imported` logs the lots and the total quantity; `parts.import.failed` the format, the
 * reason and the lot it names, never the file's content or a remark. Neither pages
 * (`docs/observability.md`, brief #153, §5): the one owner who started the import sees the
 * outcome on `/admin/parts` at once.
 */
import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { partsImport, partsLot } from '../../db/schema/parts';
import { photo } from '../../db/schema/photo';
import { adminOperation, assertAdmin, type AdminContext } from '../auth/admin-context';
import { logger as defaultLogger, type Logger } from '../logger';
import { READ_EXPIRY_SECONDS } from '../photos/config';
import { IMPORT_KEY, importKey } from '../photos/keys';
import { deployedPhotoStorage, PARTS_LOCK } from '../photos/photos';
import { guardedStorage, type PhotoStorage } from '../photos/storage';
import { db, inTransaction } from '../transaction';
import { partsMaxBytes, PARTS_UPLOAD_EXPIRY_SECONDS } from './config';
import { PARTS_PHOTO_ORDER } from './summary';
import { parsePartsFile, PartsFileRefused, type PartsFormat, type RefusalCode, type RefusedLot } from './parse';

/** The content type the presigned upload requires: the page sends the file as plain bytes. */
export const PARTS_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/** How many lots go into one insert, so a statement stays well inside the Data API's limits. */
export const LOT_BATCH = 500;

export const PresignPartsInput = z.strictObject({});

export const ImportPartsInput = z.strictObject({
  /** The key `presignPartsUpload` made, under the imports prefix. */
  uploadKey: z.string().regex(IMPORT_KEY),
});

export interface PresignedPartsUpload {
  readonly key: string;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly expiresAt: string;
}

/** Why an import was refused: the parser's reasons, a missing upload, or one over the cap. */
export type ImportRefusalCode = RefusalCode | 'upload-missing' | 'too-large';

/** What `importPartsFile` came to. A refusal changed nothing; anything unexpected throws, and changed nothing either. */
export type ImportPartsResult =
  | {
      readonly status: 'imported';
      readonly importId: string;
      readonly format: PartsFormat;
      readonly lots: number;
      readonly quantity: number;
      /** Unit price × quantity over the lots with a price, in the file's currency; null when none had one. */
      readonly totalValue: number | null;
      readonly currency: string | null;
      readonly importedAt: string;
    }
  | {
      readonly status: 'refused';
      readonly code: ImportRefusalCode;
      readonly reason: string;
      readonly lot?: RefusedLot;
    };

/** The last import, as `/admin/parts` shows it ([PARTS-4]). */
export interface PartsImportSummary {
  readonly format: PartsFormat;
  readonly lots: number;
  readonly quantity: number;
  readonly totalValue: number | null;
  readonly currency: string | null;
  readonly importedAt: string;
}

export interface PartsPhoto {
  readonly id: string;
  readonly position: number | null;
  /** Presigned GETs, each valid for 10 minutes ([PHOTO-6]). */
  readonly thumbnailUrl: string;
  readonly fullUrl: string;
}

export interface PartsPage {
  readonly summary: PartsImportSummary | null;
  readonly photos: readonly PartsPhoto[];
}

export interface PartsDependencies {
  readonly storage: () => PhotoStorage;
  readonly maxBytes?: () => number;
  readonly now?: () => Date;
  readonly log?: Logger;
}

/** Unit price × quantity, summed in thousandths so that no rounding creeps in; null when no lot has a price. */
function totalValueOf(lots: readonly { readonly quantity: number; readonly unitPrice: number | null }[]): number | null {
  let total = 0n;
  let priced = false;
  for (const lot of lots) {
    if (lot.unitPrice === null) continue;
    priced = true;
    total += BigInt(Math.round(lot.unitPrice * 1000)) * BigInt(lot.quantity);
  }
  return priced ? Number(total) / 1000 : null;
}

/** Builds the parts service functions over a storage; deployed code uses the ones below. */
export function createPartsService(dependencies: PartsDependencies) {
  const storage = () => guardedStorage(dependencies.storage());
  const maxBytes = dependencies.maxBytes ?? (() => partsMaxBytes());
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? defaultLogger;

  const presignPartsUpload = adminOperation(PresignPartsInput, async (): Promise<PresignedPartsUpload> => {
    const cap = maxBytes();
    const key = importKey();
    const expiresAt = new Date(now().getTime() + PARTS_UPLOAD_EXPIRY_SECONDS * 1000).toISOString();
    const { url, fields } = await storage().presignUpload(key, { maxBytes: cap, expiresInSeconds: PARTS_UPLOAD_EXPIRY_SECONDS, contentType: PARTS_UPLOAD_CONTENT_TYPE });
    return { key, url, fields, maxBytes: cap, expiresAt };
  });

  async function readAndReplace(admin: AdminContext, uploadKey: string): Promise<ImportPartsResult> {
    const cap = maxBytes();
    const read = await storage().read(uploadKey, cap);
    if (read.status === 'missing') return { status: 'refused', code: 'upload-missing', reason: 'the upload is not there any more: choose the file again' };
    if (read.status === 'too-large') return { status: 'refused', code: 'too-large', reason: `the file is ${read.bytes} bytes, over the cap of ${cap}` };

    let parsed;
    try {
      parsed = parsePartsFile(read.body);
    } catch (error) {
      if (error instanceof PartsFileRefused) {
        return { status: 'refused', code: error.code, reason: error.reason, ...(error.lot === undefined ? {} : { lot: error.lot }) };
      }
      throw error;
    }

    const importId = randomUUID();
    const importedAt = now();
    const quantity = parsed.lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const totalValue = totalValueOf(parsed.lots);
    await inTransaction(async () => {
      // One import at a time: a second waits for the first to commit, then replaces it.
      await db().execute(sql`select pg_advisory_xact_lock(${PARTS_LOCK})`);
      await db().delete(partsLot);
      await db().delete(partsImport);
      await db()
        .insert(partsImport)
        .values({ id: importId, fileFormat: parsed.format, currency: parsed.currency, importedAt, lots: parsed.lots.length, quantity, totalValue });
      for (let start = 0; start < parsed.lots.length; start += LOT_BATCH) {
        await db()
          .insert(partsLot)
          .values(
            parsed.lots.slice(start, start + LOT_BATCH).map((lot) => ({
              id: randomUUID(),
              importId,
              itemType: lot.itemType,
              itemNo: lot.itemNo,
              colorId: lot.colorId,
              lotCondition: lot.condition,
              lotQuantity: lot.quantity,
              unitPrice: lot.unitPrice,
            })),
          );
      }
    });
    log.info(
      { businessEvent: 'parts.imported', format: parsed.format, lots: parsed.lots.length, quantity, requestId: admin.requestId },
      'the parts inventory was replaced by an imported file',
    );
    return {
      status: 'imported',
      importId,
      format: parsed.format,
      lots: parsed.lots.length,
      quantity,
      totalValue,
      currency: parsed.currency,
      importedAt: importedAt.toISOString(),
    };
  }

  /**
   * Imports one uploaded parts file, replacing the inventory ([PARTS-3]), and deletes the upload
   * whatever it comes to ([PARTS-2]). A refusal is answered, not thrown; it changed nothing.
   */
  const importPartsFile = adminOperation(ImportPartsInput, async (admin, input): Promise<ImportPartsResult> => {
    let result: ImportPartsResult | undefined;
    try {
      result = await readAndReplace(admin, input.uploadKey);
      if (result.status === 'refused') {
        log.warn(
          {
            businessEvent: 'parts.import.failed',
            reason: result.code,
            ...(result.lot === undefined ? {} : { lot: result.lot }),
            requestId: admin.requestId,
          },
          'a parts file was refused and the inventory is unchanged',
        );
      }
      return result;
    } catch (error) {
      log.error(
        { businessEvent: 'parts.import.failed', reason: 'failed', cause: error instanceof Error ? error.name : typeof error, requestId: admin.requestId },
        'a parts import failed on the server and the inventory is unchanged',
      );
      throw error;
    } finally {
      try {
        await storage().delete(input.uploadKey);
      } catch (error) {
        log.error(
          { businessEvent: 'parts.cleanup.failed', requestId: admin.requestId, cause: error instanceof Error ? error.name : typeof error },
          'an uploaded parts file could not be deleted; the imports prefix’s lifecycle rule expires it within about a day',
        );
      }
    }
  });

  /** The last import's summary and the overview photos, with presigned URLs, for `/admin/parts` ([PARTS-4]). */
  async function readPartsPage(admin: AdminContext): Promise<PartsPage> {
    assertAdmin(admin);
    const [last] = await db().select().from(partsImport).orderBy(desc(partsImport.importedAt)).limit(1);
    const rows = await db()
      .select({ id: photo.id, position: photo.position, fullKey: photo.fullKey, thumbnailKey: photo.thumbnailKey })
      .from(photo)
      .where(eq(photo.partsLot, true))
      .orderBy(...PARTS_PHOTO_ORDER);
    const photos = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        position: row.position,
        thumbnailUrl: await storage().presignRead(row.thumbnailKey, READ_EXPIRY_SECONDS),
        fullUrl: await storage().presignRead(row.fullKey, READ_EXPIRY_SECONDS),
      })),
    );
    const summary: PartsImportSummary | null =
      last === undefined
        ? null
        : {
            format: last.fileFormat,
            lots: last.lots,
            quantity: last.quantity,
            totalValue: last.totalValue === null ? null : Number(last.totalValue),
            currency: last.currency,
            importedAt: last.importedAt.toISOString(),
          };
    return { summary, photos };
  }

  return { presignPartsUpload, importPartsFile, readPartsPage };
}

/** The parts service as deployed: the linked photo bucket and the server function's cap. */
export const parts = createPartsService({ storage: deployedPhotoStorage });

export const { presignPartsUpload, importPartsFile, readPartsPage } = parts;

export { readPartsSummary, type PartsSummary } from './summary';
