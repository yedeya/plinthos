/**
 * The deployed photo storage: the private photo bucket `infra/photos.ts` creates, reached through
 * the `Photos` resource it links to the admin's server function. That role may write, read and
 * delete only under `quarantine/` (writing there is what lets it sign the phone's upload) and
 * `photos/`, only write under `trash/` (moving a deleted photo there is a copy), and list the
 * bucket, so a missing key reads as missing.
 *
 * The upload is a presigned POST, not a PUT, because only a POST policy can cap the body's size:
 * S3 refuses a form whose file is over `content-length-range`, whose key is not the one signed,
 * or that arrives after the policy's expiry ([PHOTO-1], [PHOTO-7]). A stand-in can't show S3
 * enforcing those, so Issue K measures them in the deployment.
 *
 * The client connects on first use, never on import. Every call has a timeout, and the SDK's
 * standard retry mode backs off and retries a throttled or failed call (`AGENTS.md` §1).
 */
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Resource } from 'sst/resource';
import { z } from 'zod';
import { trashKeyFor } from './keys';
import type { PhotoStorage, ReadResult } from './storage';

/** What the admin is linked to: the bucket's name. */
export const PhotosResource = z.object({ bucket: z.string().min(1) });

const CLIENT_OPTIONS = {
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 },
} as const;

let bucketName: string | undefined;

/** The linked `Photos` bucket's name, read on first use. */
export function photosBucket(): string {
  bucketName ??= PhotosResource.parse((Resource as unknown as { Photos: unknown }).Photos).bucket;
  return bucketName;
}

/** The bucket as a `PhotoStorage`. */
export function s3PhotoStorage(bucket: string, client: S3Client = new S3Client(CLIENT_OPTIONS)): PhotoStorage {
  return {
    async presignUpload(key, conditions) {
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ['eq', '$key', key],
          ['content-length-range', 1, conditions.maxBytes],
          ['eq', '$Content-Type', conditions.contentType],
        ],
        Fields: { 'Content-Type': conditions.contentType },
        Expires: conditions.expiresInSeconds,
      });
      return { url, fields };
    },
    async read(key, maxBytes): Promise<ReadResult> {
      let object;
      try {
        object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (error instanceof NoSuchKey || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) return { status: 'missing' };
        throw error;
      }
      if (object.Body === undefined) return { status: 'missing' };
      const length = object.ContentLength ?? 0;
      if (length > maxBytes) {
        // Stop the download rather than read a body over the cap into memory.
        (object.Body as { destroy?: () => void }).destroy?.();
        return { status: 'too-large', bytes: length };
      }
      const body = await object.Body.transformToByteArray();
      if (body.byteLength > maxBytes) return { status: 'too-large', bytes: body.byteLength };
      return { status: 'read', body };
    },
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=600' }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async trash(key) {
      try {
        // Stored keys are base64url and `.webp`, so the copy source needs no escaping.
        await client.send(new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${key}`, Key: trashKeyFor(key) }));
      } catch (error) {
        if (error instanceof NoSuchKey || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) return;
        throw error;
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async presignRead(key, expiresInSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
  };
}
