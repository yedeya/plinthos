/**
 * The set index's prefix of the private photo bucket, as a `SetIndexStore` (brief #252, Issue A).
 * `infra/set-index.ts` links it twice, each time under its own name with its own permissions:
 *
 * - `SetIndexWriter`, to the builder alone: it may read, write and delete under `set-index/`, and
 *   list the bucket only under that prefix, so a missing key reads as missing rather than refused
 *   ([CAT-7], [CAT-8]).
 * - `SetIndexReader`, to the admin's server function: it may read under `set-index/`, and nothing
 *   more of it ([CAT-9]). Its `Photos` link already lets it list the bucket.
 *
 * The client connects on first use, never on import, so a module that imports this one reaches
 * nothing until it reads. Every call has a timeout, and the SDK's standard retry mode backs off and
 * retries a throttled or failed call (`AGENTS.md` §1), as the photo storage's does
 * (`src/server/photos/aws.ts`).
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { Resource } from 'sst/resource';
import { z } from 'zod';
import type { SetIndexStore } from './format';

/** The builder's link: read, write and delete under the prefix. */
export const WRITER_LINK = 'SetIndexWriter';
/** The admin's link: read under the prefix. */
export const READER_LINK = 'SetIndexReader';

/** The largest object read back: an index is about 640 KB (brief #252, §1). */
export const MAX_STORED_BYTES = 16 * 1024 * 1024;

const LinkedBucket = z.object({ bucket: z.string().min(1) });

const CLIENT_OPTIONS = {
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 },
} as const;

function isMissing(error: unknown): boolean {
  return error instanceof NoSuchKey || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404);
}

/** The prefix of a bucket as a store. */
export function s3SetIndexStore(bucket: string, client: S3Client = new S3Client(CLIENT_OPTIONS)): SetIndexStore {
  return {
    async get(key) {
      let object;
      try {
        object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (object.Body === undefined) return null;
      if ((object.ContentLength ?? 0) > MAX_STORED_BYTES) {
        (object.Body as { destroy?: () => void }).destroy?.();
        throw new Error(`the set index’s ${key} is larger than ${MAX_STORED_BYTES} bytes`);
      }
      return object.Body.transformToByteArray();
    },
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'no-store' }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const object of page.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key);
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return keys;
    },
  };
}

/** The store through one of the two links, whose bucket is read, and client made, on first use. */
export function linkedSetIndexStore(link: typeof WRITER_LINK | typeof READER_LINK): SetIndexStore {
  let store: SetIndexStore | undefined;
  const resolve = (): SetIndexStore => {
    store ??= s3SetIndexStore(LinkedBucket.parse((Resource as unknown as Record<string, unknown>)[link]).bucket);
    return store;
  };
  return {
    get: (key) => resolve().get(key),
    put: (key, body, contentType) => resolve().put(key, body, contentType),
    delete: (key) => resolve().delete(key),
    list: (prefix) => resolve().list(prefix),
  };
}
