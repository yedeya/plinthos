import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARTS_MAX_BYTES as INFRA_DEFAULT, PARTS_MAX_BYTES_RANGE as INFRA_RANGE } from '../../../infra/config';
import { readDatabaseUrl } from '../../../src/db/database-url';
import { applyMigrations } from '../../../src/db/migrate';
import * as schema from '../../../src/db/schema';
import { CLASSIFICATION } from '../../../src/db/schema/classification';
import { issueAdminContext, NotAdminError, type AdminContext } from '../../../src/server/auth/admin-context';
import { DEFAULT_PARTS_MAX_BYTES, PARTS_MAX_BYTES_RANGE, partsMaxBytes, PARTS_UPLOAD_EXPIRY_SECONDS } from '../../../src/server/parts/config';
import { createPartsService, PARTS_UPLOAD_CONTENT_TYPE, readPartsSummary } from '../../../src/server/parts/parts';
import { IMPORT_KEY, IMPORT_PREFIX, importKey, quarantineKey } from '../../../src/server/photos/keys';
import { createPhotoService, MAX_PARTS_PHOTOS, REFUSALS } from '../../../src/server/photos/photos';
import { guardedStorage, MAX_PRESIGN_SECONDS, StorageRuleError } from '../../../src/server/photos/storage';
import { syncRegistry } from '../../../src/server/sync/registry';
import { createReplay, type MutationOutcome } from '../../../src/server/sync/replay';
import { freshDatabase, type FreshDatabase } from '../../support/fresh-database';
import { readRepoFile } from '../../support/repo-file';
import { captureLogger } from '../capture';
import { memoryBucket, plainPhoto, sha256, type MemoryBucket } from '../photos/fakes';

/**
 * `importPartsFile`, its upload and the parts lot's overview photos (#161, [PARTS-2] to
 * [PARTS-5]), over the test database and an in-memory photo bucket. Every file is made up: the
 * fixtures under `tests/fixtures/parts/` and the small ones written here.
 */

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../../src/server/database', () => ({ database: () => state.db }));

const MAX_BYTES = 64 * 1024;

let fresh: FreshDatabase;
let pool: pg.Pool;
let admin: AdminContext;
let bucket: MemoryBucket;
let capture: ReturnType<typeof captureLogger>;

beforeAll(async () => {
  fresh = await freshDatabase();
  await applyMigrations(fresh.db, fresh.migrate);
  const url = new URL(readDatabaseUrl());
  url.pathname = `/${fresh.client.database ?? ''}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  state.db = drizzle(pool, { schema });
  // A made-up failure inside the transaction, after the old inventory was deleted: a lot numbered FAIL-ME.
  await fresh.client.query(`
    create function parts_test_fail() returns trigger language plpgsql as $$
    begin if new.item_no = 'FAIL-ME' then raise exception 'made-up failure inside the import'; end if; return new; end $$;
    create trigger parts_test_fail before insert on parts_lot for each row execute function parts_test_fail();
  `);
});
afterAll(async () => {
  await pool.end();
  await fresh.drop();
});
beforeEach(async () => {
  await fresh.client.query('truncate applied_mutation, photo, parts_lot, parts_import cascade');
  admin = issueAdminContext({ sessionKey: randomUUID(), requestId: randomUUID() });
  bucket = memoryBucket();
  capture = captureLogger();
});

const encode = (text: string) => new TextEncoder().encode(text);
const fixture = (name: string) => encode(readRepoFile(`tests/fixtures/parts/${name}`));
const bl = (lots: string) => encode(`<?xml version="1.0"?><INVENTORY>${lots}</INVENTORY>`);
const blLot = (itemNo: string, qty: number, price?: string) =>
  `<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>${itemNo}</ITEMID><COLOR>1</COLOR><QTY>${qty}</QTY>${price === undefined ? '' : `<PRICE>${price}</PRICE>`}<REMARKS>BIN-CANARY-${itemNo}</REMARKS></ITEM>`;

function parts() {
  return createPartsService({ storage: () => bucket.storage, maxBytes: () => MAX_BYTES, log: capture.log });
}

/** Presigns an upload as the route does, and puts the bytes there as the page's POST does. */
async function uploaded(bytes: Uint8Array): Promise<string> {
  const presigned = await parts().presignPartsUpload(admin, {});
  bucket.objects.set(presigned.key, { body: bytes, contentType: PARTS_UPLOAD_CONTENT_TYPE });
  return presigned.key;
}

async function lots(): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query('select item_type, item_no, color_id, lot_condition, lot_quantity, unit_price from parts_lot order by item_no')).rows as Record<
    string,
    unknown
  >[];
}

async function imports(): Promise<Record<string, unknown>[]> {
  return (await fresh.client.query('select * from parts_import')).rows as Record<string, unknown>[];
}

const uploads = () => [...bucket.objects.keys()].filter((key) => key.startsWith(IMPORT_PREFIX));

describe('the upload', () => {
  it('[PARTS-2] is presigned into the private imports prefix, for a random key, capped at the configured size and expiring within 15 minutes', async () => {
    const before = Date.now();
    const presigned = await parts().presignPartsUpload(admin, {});
    expect(presigned.key).toMatch(IMPORT_KEY);
    expect(presigned.maxBytes).toBe(MAX_BYTES);
    expect(bucket.presigned).toEqual([
      { key: presigned.key, conditions: { maxBytes: MAX_BYTES, expiresInSeconds: PARTS_UPLOAD_EXPIRY_SECONDS, contentType: PARTS_UPLOAD_CONTENT_TYPE } },
    ]);
    expect(PARTS_UPLOAD_EXPIRY_SECONDS).toBeLessThanOrEqual(MAX_PRESIGN_SECONDS);
    expect(new Date(presigned.expiresAt).getTime() - before).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(new Set(Array.from({ length: 50 }, () => importKey())).size).toBe(50);
    await expect(parts().presignPartsUpload({ sessionKey: 'x', requestId: 'y' } as unknown as AdminContext, {})).rejects.toThrow(NotAdminError);
  });

  it('[PARTS-2] is never served: no presigned read and no write under the imports prefix, and nothing but a server-made key is read', async () => {
    const guarded = guardedStorage(bucket.storage);
    await expect(guarded.presignRead(importKey(), 60)).rejects.toThrow(StorageRuleError);
    await expect(guarded.put(importKey(), new Uint8Array([1]), 'application/xml')).rejects.toThrow(StorageRuleError);
    await expect(guarded.trash(importKey())).rejects.toThrow(StorageRuleError);
    await expect(guarded.read('imports/chosen-by-client.xml', 10)).rejects.toThrow(StorageRuleError);
    await expect(guarded.presignUpload('imports/chosen-by-client.xml', { maxBytes: 10, expiresInSeconds: 60, contentType: 'application/octet-stream' })).rejects.toThrow(
      StorageRuleError,
    );
  });

  it('[PARTS-2] takes its cap from PLINTHOS_PARTS_MAX_BYTES, 20 MiB by default, with the bounds the deployment checks', () => {
    expect(partsMaxBytes({})).toBe(20 * 1024 * 1024);
    expect(partsMaxBytes({ PLINTHOS_PARTS_MAX_BYTES: '1048576' })).toBe(1048576);
    expect(partsMaxBytes({ PLINTHOS_PARTS_MAX_BYTES: 'lots' })).toBe(DEFAULT_PARTS_MAX_BYTES);
    expect(Number(INFRA_DEFAULT)).toBe(DEFAULT_PARTS_MAX_BYTES);
    expect(INFRA_RANGE).toEqual(PARTS_MAX_BYTES_RANGE);
    expect(readRepoFile('docs/deploy.md')).toContain('`PLINTHOS_PARTS_MAX_BYTES`');
  });

  it('[PARTS-2] is read with the cap, and deleted whatever the import comes to: imported, refused, too large or failed', async () => {
    const ok = await uploaded(fixture('made-up.bsx'));
    expect((await parts().importPartsFile(admin, { uploadKey: ok })).status).toBe('imported');
    expect(bucket.reads).toEqual([{ key: ok, maxBytes: MAX_BYTES }]);
    expect(uploads()).toEqual([]);

    const refused = await uploaded(encode('<html>not a parts file</html>'));
    expect(await parts().importPartsFile(admin, { uploadKey: refused })).toMatchObject({ status: 'refused', code: 'unknown-format' });
    expect(uploads()).toEqual([]);

    const large = await uploaded(new Uint8Array(MAX_BYTES + 1));
    expect(await parts().importPartsFile(admin, { uploadKey: large })).toMatchObject({ status: 'refused', code: 'too-large' });
    expect(uploads()).toEqual([]);

    const failing = await uploaded(bl(blLot('FAIL-ME', 1)));
    await expect(parts().importPartsFile(admin, { uploadKey: failing })).rejects.toThrow();
    expect(uploads()).toEqual([]);

    expect(await parts().importPartsFile(admin, { uploadKey: importKey() })).toMatchObject({ status: 'refused', code: 'upload-missing' });
    expect(bucket.calls.filter((call) => call.startsWith('delete '))).toHaveLength(5);
  });
});

describe('the import', () => {
  it('[PARTS-3] is an admin operation with validated input: a forged context, or a key outside the imports prefix, is refused before anything is read', async () => {
    const key = await uploaded(fixture('made-up.bsx'));
    await expect(parts().importPartsFile({ sessionKey: 'x', requestId: 'y' } as unknown as AdminContext, { uploadKey: key })).rejects.toThrow(NotAdminError);
    for (const uploadKey of [quarantineKey(), 'imports/chosen-by-client.xml', `${key}/../photos/x.webp`]) {
      await expect(parts().importPartsFile(admin, { uploadKey })).rejects.toThrow();
    }
    await expect(parts().importPartsFile(admin, { uploadKey: key, extra: 1 } as never)).rejects.toThrow();
    expect(bucket.reads).toEqual([]);
    expect(await imports()).toEqual([]);
  });

  it('[PARTS-3] stores the file’s lots and a parts_import row with its format, lots, total quantity and total value, and no remark', async () => {
    const key = await uploaded(fixture('made-up.bsx'));
    const result = await parts().importPartsFile(admin, { uploadKey: key });
    expect(result).toMatchObject({ status: 'imported', format: 'BSX', lots: 3, quantity: 167, currency: 'EUR' });
    // 120 × 0.085 + 2 × 3.5, the lot with no price left out.
    expect(result.status === 'imported' ? result.totalValue : undefined).toBe(17.2);
    expect(await lots()).toEqual([
      { item_type: 'P', item_no: '3001', color_id: 5, lot_condition: 'N', lot_quantity: 120, unit_price: '0.085' },
      { item_type: 'P', item_no: '3069b', color_id: 11, lot_condition: 'U', lot_quantity: 45, unit_price: null },
      { item_type: 'M', item_no: 'sw0001a', color_id: 0, lot_condition: 'N', lot_quantity: 2, unit_price: '3.500' },
    ]);
    const [row] = await imports();
    expect(row).toMatchObject({ file_format: 'BSX', currency: 'EUR', lots: 3, quantity: 167, total_value: '17.200' });
    const everything = JSON.stringify(await fresh.client.query('select * from parts_lot, parts_import').then(({ rows }) => rows));
    expect(everything).not.toMatch(/CANARY|shelf|drawer/);
    const event = capture.events().find((line) => line.businessEvent === 'parts.imported');
    expect(event).toMatchObject({ format: 'BSX', lots: 3, quantity: 167, requestId: admin.requestId });
    expect(capture.lines.join('\n')).not.toMatch(/CANARY|17\.2|0\.085/);
  });

  it('[PARTS-3] replaces the inventory rather than merging it: a second import leaves only its own lots and one import row', async () => {
    await parts().importPartsFile(admin, { uploadKey: await uploaded(fixture('made-up.bsx')) });
    const second = await parts().importPartsFile(admin, { uploadKey: await uploaded(fixture('made-up-bricklink.xml')) });
    expect(second).toMatchObject({ status: 'imported', format: 'BL_XML', lots: 2, quantity: 301, totalValue: 6, currency: null });
    expect((await lots()).map((lot) => lot.item_no)).toEqual(['3023', '973pb0001c01']);
    expect(await imports()).toHaveLength(1);
    expect((await imports())[0]).toMatchObject({ file_format: 'BL_XML', lots: 2, quantity: 301 });
  });

  it('[PARTS-3] records no total value when no lot has a price', async () => {
    const result = await parts().importPartsFile(admin, { uploadKey: await uploaded(bl(blLot('3001', 4))) });
    expect(result).toMatchObject({ status: 'imported', totalValue: null });
    expect((await imports())[0]?.total_value).toBeNull();
  });

  it('[PARTS-3] changes nothing when an import is refused or fails, and logs parts.import.failed with the reason and the lot, never a remark', async () => {
    await parts().importPartsFile(admin, { uploadKey: await uploaded(fixture('made-up.bsx')) });
    const before = { lots: await lots(), imports: await imports() };

    const refused = await parts().importPartsFile(admin, { uploadKey: await uploaded(bl(`${blLot('3001', 2)}${blLot('3002', 0)}`)) });
    expect(refused).toEqual({ status: 'refused', code: 'invalid-lot', reason: 'the quantity is not a positive whole number', lot: { index: 2, itemNo: '3002' } });
    expect({ lots: await lots(), imports: await imports() }).toEqual(before);

    await expect(parts().importPartsFile(admin, { uploadKey: await uploaded(bl(`${blLot('3001', 2)}${blLot('FAIL-ME', 1)}`)) })).rejects.toThrow();
    expect({ lots: await lots(), imports: await imports() }).toEqual(before);

    const failed = capture.events().filter((line) => line.businessEvent === 'parts.import.failed');
    expect(failed).toEqual([
      expect.objectContaining({ level: 'warn', reason: 'invalid-lot', lot: { index: 2, itemNo: '3002' }, requestId: admin.requestId }),
      expect.objectContaining({ level: 'error', reason: 'failed', cause: expect.any(String), requestId: admin.requestId }),
    ]);
    expect(capture.lines.join('\n')).not.toContain('CANARY');
  });
});

describe('the summary', () => {
  it('[PARTS-4] /admin/parts reads the last import’s lots, parts, total value and when it was imported', async () => {
    expect(await parts().readPartsPage(admin)).toEqual({ summary: null, photos: [] });
    await parts().importPartsFile(admin, { uploadKey: await uploaded(fixture('made-up.bsx')) });
    const { summary } = await parts().readPartsPage(admin);
    expect(summary).toEqual({ format: 'BSX', lots: 3, quantity: 167, totalValue: 17.2, currency: 'EUR', importedAt: expect.any(String) });
    expect(Date.now() - new Date(summary?.importedAt ?? 0).getTime()).toBeLessThan(60_000);
    await expect(parts().readPartsPage({ sessionKey: 'x', requestId: 'y' } as unknown as AdminContext)).rejects.toThrow(NotAdminError);
  });

  it('[PARTS-4] classifies every column of parts_import and parts_lot, with unit prices and values private', () => {
    expect(Object.keys(CLASSIFICATION.parts_import ?? {}).sort()).toEqual(['currency', 'file_format', 'id', 'imported_at', 'lots', 'quantity', 'total_value']);
    expect(CLASSIFICATION.parts_import?.total_value?.visibility).toBe('private');
    expect(CLASSIFICATION.parts_lot?.unit_price?.visibility).toBe('private');
    // Since #211 a lot's five download fields are public, published only in selling mode's parts
    // download (PUB-20); its keys and its unit price stay private.
    const download = ['item_type', 'item_no', 'color_id', 'lot_condition', 'lot_quantity'];
    for (const [column, { visibility }] of Object.entries(CLASSIFICATION.parts_lot ?? {})) expect(visibility, column).toBe(download.includes(column) ? 'public' : 'private');
  });
});

describe('the overview photos', () => {
  function photos() {
    return createPhotoService({ storage: () => bucket.storage, settings: () => ({ longestEdge: 256, maxBytes: 256 * 1024 }), log: capture.log });
  }

  async function registerParts(bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<MutationOutcome> {
    const presigned = await photos().presignPhotoUpload(admin, {});
    bucket.upload(presigned.key, bytes);
    const replay = createReplay(syncRegistry(photos().mutations), { log: capture.log });
    const { outcomes } = await replay(admin, {
      mutations: [{ id: randomUUID(), name: 'registerPhoto', input: { quarantineKey: presigned.key, sha256: sha256(bytes), partsLot: true, ...extra } }],
    });
    const [outcome] = outcomes;
    if (outcome === undefined) throw new Error('no outcome');
    return outcome;
  }

  it('[PARTS-5] go through the same re-encoded photo path, in order, and the publish step reads their keys with the summary and no value', async () => {
    const outcomes = [];
    for (let index = 0; index < 3; index += 1) outcomes.push(await registerParts(await plainPhoto(40 + index, 30)));
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['applied', 'applied', 'applied']);
    const rows = (await fresh.client.query('select parts_lot, item_id, position, full_key, thumbnail_key from photo order by position')).rows as Record<string, unknown>[];
    expect(rows.map((row) => [row.parts_lot, row.item_id, row.position])).toEqual([
      [true, null, 0],
      [true, null, 1],
      [true, null, 2],
    ]);
    // Re-encoded like any photo: two WebP sizes each, and no quarantined upload left.
    expect([...bucket.objects.keys()].filter((key) => key.startsWith('quarantine/'))).toEqual([]);
    expect([...bucket.objects.keys()].filter((key) => key.endsWith('.webp'))).toHaveLength(6);

    expect(await readPartsSummary(fresh.db as never)).toEqual({
      lots: 0,
      quantity: 0,
      photos: rows.map((row) => ({ fullKey: row.full_key, thumbnailKey: row.thumbnail_key })),
    });
    await parts().importPartsFile(admin, { uploadKey: await uploaded(fixture('made-up.bsx')) });
    const summary = await readPartsSummary(fresh.db as never);
    expect(summary).toMatchObject({ lots: 3, quantity: 167 });
    expect(Object.keys(summary ?? {}).sort()).toEqual(['lots', 'photos', 'quantity']);
    const page = await parts().readPartsPage(admin);
    expect(page.photos.map((photo) => photo.position)).toEqual([0, 1, 2]);
    for (const photo of page.photos) expect(photo.thumbnailUrl).toMatch(/X-Amz-Expires=600/);
  });

  it('[PARTS-5] are at most 12: one more is refused before anything is stored, and its upload is deleted', async () => {
    for (let index = 0; index < MAX_PARTS_PHOTOS; index += 1) expect((await registerParts(await plainPhoto(32 + index, 24))).outcome).toBe('applied');
    const stored = bucket.objects.size;
    const over = await registerParts(await plainPhoto(80, 60));
    expect(over).toMatchObject({ outcome: 'invalid', code: REFUSALS.partsPhotosFull });
    expect(bucket.objects.size).toBe(stored);
    expect((await fresh.client.query('select count(*)::int as n from photo where parts_lot')).rows[0]).toEqual({ n: MAX_PARTS_PHOTOS });
  });

  it('[PARTS-5] belong to an item or to the parts lot, never both: the input and the database both refuse it', async () => {
    const outcome = await registerParts(await plainPhoto(), { itemId: randomUUID() });
    expect(outcome.outcome).toBe('invalid');
    // Nothing stored: an input the schema refuses never reaches the re-encode.
    expect([...bucket.objects.keys()].filter((key) => !key.startsWith('quarantine/'))).toEqual([]);
    await fresh.client.query(`insert into lego_set (id, set_num, name, theme, year, num_parts, fetched_at) values ($1, '1-1', 'Made up', 'Made up', 2000, 1, now())`, [randomUUID()]);
    const itemId = randomUUID();
    await fresh.client.query(
      `insert into collection_item (id, set_num, condition, complete, has_instructions, description, quantity, storage_location, version, created_at, updated_at)
       values ($1, '1-1', 'SEALED', true, true, '', 1, '', 1, now(), now())`,
      [itemId],
    );
    await expect(
      fresh.client.query(`insert into photo (id, full_key, thumbnail_key, sha256, created_at, item_id, parts_lot) values ($1, 'a', 'b', 'c', now(), $2, true)`, [randomUUID(), itemId]),
    ).rejects.toThrow(/photo_item_or_parts_lot_check/);
  });
});
