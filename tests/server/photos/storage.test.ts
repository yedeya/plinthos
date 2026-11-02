import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { s3PhotoStorage } from '../../../src/server/photos/aws';
import { photoSettings, DEFAULT_LONGEST_EDGE, DEFAULT_MAX_BYTES } from '../../../src/server/photos/config';
import { QUARANTINE_KEY, quarantineKey, STORED_KEY, storedKey, trashKeyFor } from '../../../src/server/photos/keys';
import { guardedStorage, StorageRuleError } from '../../../src/server/photos/storage';
import { memoryBucket } from './fakes';

/**
 * The photo storage's own rules ([PHOTO-6], [PHOTO-7]), and the presigned requests the S3
 * implementation signs. Signing happens on the machine, with made-up credentials and no network:
 * what S3 then does with them (refusing a body over the cap, a key other than the signed one, a
 * late upload) only a deployment shows, and Issue K measures it.
 */

const fakeClient = () =>
  new S3Client({ region: 'eu-central-1', credentials: { accessKeyId: 'AKIAMADEUPFAKE000000', secretAccessKey: 'made-up-secret-access-key-for-tests-only' } });

describe('the keys', () => {
  it('[PHOTO-6] [PHOTO-7] are made from 256 random bits, under the quarantine prefix for an upload and outside it for a stored size', () => {
    const keys = Array.from({ length: 200 }, () => [quarantineKey(), storedKey()]).flat();
    expect(new Set(keys).size).toBe(keys.length);
    for (let index = 0; index < keys.length; index += 2) {
      expect(keys[index]).toMatch(QUARANTINE_KEY);
      expect(keys[index + 1]).toMatch(STORED_KEY);
    }
    // 43 base64url characters carry 258 bits, of which 256 are random: at least 128 (PHOTO-6).
    expect(quarantineKey().split('/')[1]?.split('.')[0]).toHaveLength(43);
  });
});

describe('the storage rules every caller passes through', () => {
  const guarded = () => guardedStorage(memoryBucket().storage);

  it('[PHOTO-7] never presigns a read of a key under the quarantine prefix', async () => {
    await expect(guarded().presignRead(quarantineKey(), 60)).rejects.toThrow(StorageRuleError);
    await expect(guarded().presignRead('quarantine/anything', 60)).rejects.toThrow(StorageRuleError);
  });

  it('[PHOTO-3] [PHOTO-7] writes only stored sizes outside the quarantine, and presigns an upload only into it', async () => {
    await expect(guarded().put(quarantineKey(), new Uint8Array([1]), 'image/webp')).rejects.toThrow(StorageRuleError);
    await expect(guarded().put('photos/chosen-by-client.webp', new Uint8Array([1]), 'image/webp')).rejects.toThrow(StorageRuleError);
    await expect(guarded().presignUpload(storedKey(), { maxBytes: 10, expiresInSeconds: 60, contentType: 'image/jpeg' })).rejects.toThrow(StorageRuleError);
    await expect(guarded().put(storedKey(), new Uint8Array([1]), 'image/webp')).resolves.toBeUndefined();
  });

  it('[PHOTO-6] [PHOTO-7] refuses a presigned URL that lives longer than 15 minutes, and an upload with no cap', async () => {
    await expect(guarded().presignRead(storedKey(), 15 * 60 + 1)).rejects.toThrow(StorageRuleError);
    await expect(guarded().presignUpload(quarantineKey(), { maxBytes: 10, expiresInSeconds: 15 * 60 + 1, contentType: 'image/jpeg' })).rejects.toThrow(StorageRuleError);
    await expect(guarded().presignUpload(quarantineKey(), { maxBytes: Number.POSITIVE_INFINITY, expiresInSeconds: 60, contentType: 'image/jpeg' })).rejects.toThrow(
      StorageRuleError,
    );
  });
});

describe('the S3 implementation', () => {
  it('[PHOTO-1] [PHOTO-7] presigns a POST whose policy pins the key, caps the body, requires a JPEG and expires within 15 minutes', async () => {
    const key = quarantineKey();
    const before = Date.now();
    const { url, fields } = await s3PhotoStorage('made-up-photo-bucket', fakeClient()).presignUpload(key, {
      maxBytes: 4096,
      expiresInSeconds: 600,
      contentType: 'image/jpeg',
    });
    expect(url).toContain('made-up-photo-bucket');
    expect(fields.key).toBe(key);
    const policy = JSON.parse(Buffer.from(String(fields.Policy), 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        { bucket: 'made-up-photo-bucket' },
        { key },
        ['eq', '$key', key],
        ['content-length-range', 1, 4096],
        ['eq', '$Content-Type', 'image/jpeg'],
      ]),
    );
    const lifetime = new Date(policy.expiration).getTime() - before;
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('[PHOTO-9] [PHOTO-7] moves only a stored size to the trash, never a quarantined upload, and never serves the trash', async () => {
    const guarded = () => guardedStorage(memoryBucket().storage);
    await expect(guarded().trash(quarantineKey())).rejects.toThrow(StorageRuleError);
    const key = storedKey();
    expect(trashKeyFor(key)).toBe(`trash/${key.slice('photos/'.length)}`);
    await expect(guarded().presignRead(trashKeyFor(key), 60)).rejects.toThrow(StorageRuleError);
    await expect(guarded().read(trashKeyFor(key), 10)).rejects.toThrow(StorageRuleError);
  });

  it('[PHOTO-9] moves a stored size to the trash by copying it there, then deleting it', async () => {
    const key = storedKey();
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => void sent.push({ name: command.constructor.name, input: command.input }) };
    await s3PhotoStorage('made-up-photo-bucket', client as unknown as S3Client).trash(key);
    expect(sent).toEqual([
      { name: 'CopyObjectCommand', input: { Bucket: 'made-up-photo-bucket', CopySource: `made-up-photo-bucket/${key}`, Key: trashKeyFor(key) } },
      { name: 'DeleteObjectCommand', input: { Bucket: 'made-up-photo-bucket', Key: key } },
    ]);
  });

  it('[PHOTO-6] presigns a GET of one stored size that expires within 15 minutes', async () => {
    const key = storedKey();
    const url = new URL(await s3PhotoStorage('made-up-photo-bucket', fakeClient()).presignRead(key, 600));
    expect(url.pathname).toContain(key);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(600);
  });
});

describe('the settings', () => {
  it('[PHOTO-1] read the longest edge and the size cap from the environment, within bounds, with defaults', () => {
    expect(photoSettings({})).toEqual({ longestEdge: DEFAULT_LONGEST_EDGE, maxBytes: DEFAULT_MAX_BYTES });
    expect(photoSettings({ PLINTHOS_PHOTO_LONGEST_EDGE: '1600', PLINTHOS_PHOTO_MAX_BYTES: '2000000' })).toEqual({ longestEdge: 1600, maxBytes: 2000000 });
    expect(photoSettings({ PLINTHOS_PHOTO_LONGEST_EDGE: '99999', PLINTHOS_PHOTO_MAX_BYTES: 'lots' })).toEqual({ longestEdge: DEFAULT_LONGEST_EDGE, maxBytes: DEFAULT_MAX_BYTES });
  });
});
