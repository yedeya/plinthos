/**
 * The deployed snapshot store and its distribution: the private bucket and the public
 * CloudFront distribution `infra/snapshot.ts` creates, reached through the `Snapshot` resource it
 * links to the admin's server function, whose role may write only under `c/` and invalidate only
 * that distribution. A published photo is copied from the private photo bucket
 * (`infra/photos.ts`), which the same function may read under `photos/`: S3's CopyObject needs
 * `s3:GetObject` on the source and `s3:PutObject` on the target, both of which it has ([PUB-13]).
 *
 * Each client connects on first use, never on import. Every call has a timeout, and the SDK's
 * standard retry mode backs off and retries a throttled or failed call (`AGENTS.md` §1).
 */
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Resource } from 'sst/resource';
import { z } from 'zod';
import { STORED_KEY } from '../photos/keys';
import type { SnapshotObject, SnapshotStore } from './snapshot';

/** What the admin is linked to: the bucket's name, the distribution's id and its address. */
export const SnapshotResource = z.object({
  bucket: z.string().min(1),
  distributionId: z.string().min(1),
  url: z.string().startsWith('https://'),
});
export type SnapshotResource = z.infer<typeof SnapshotResource>;

/** Each call's ceiling, and the attempts the SDK makes with backoff between them. */
const CLIENT_OPTIONS = {
  maxAttempts: 3,
  retryMode: 'standard',
  requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 },
} as const;

let resource: SnapshotResource | undefined;

/** The linked `Snapshot` resource, read on first use. */
export function snapshotResource(): SnapshotResource {
  resource ??= SnapshotResource.parse((Resource as unknown as { Snapshot: unknown }).Snapshot);
  return resource;
}

/** The bucket as a `SnapshotStore`, copying published photos from `photoBucket`. */
export function s3SnapshotStore(bucket: string, photoBucket: () => string, client: S3Client = new S3Client(CLIENT_OPTIONS)): SnapshotStore {
  return {
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (object.Body === undefined) return null;
        return {
          body: await object.Body.transformToByteArray(),
          contentType: object.ContentType ?? 'application/octet-stream',
          cacheControl: object.CacheControl ?? '',
        } satisfies SnapshotObject;
      } catch (error) {
        // The admin's role may list the bucket, so a missing key is NoSuchKey, never AccessDenied.
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
    async put(key, object) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: object.body,
          ContentType: object.contentType,
          CacheControl: object.cacheControl,
        }),
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
        for (const object of page.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key);
        ContinuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (ContinuationToken !== undefined);
      return keys;
    },
    async copyPhoto(storedKey, key, headers) {
      // Only a stored size, whose key is base64url and `.webp`, so the copy source needs no escaping.
      if (!STORED_KEY.test(storedKey)) throw new Error('Only a stored photo size is copied into the snapshot.');
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: `${photoBucket()}/${storedKey}`,
          // The snapshot's own headers, and none of the source's metadata or tags.
          MetadataDirective: 'REPLACE',
          TaggingDirective: 'REPLACE',
          ContentType: headers.contentType,
          CacheControl: headers.cacheControl,
        }),
      );
    },
  };
}

/** Asks the distribution to drop its copies of the given paths; it does not wait for them to go. */
export function cloudFrontInvalidator(distributionId: string, client: CloudFrontClient = new CloudFrontClient(CLIENT_OPTIONS)) {
  return async (paths: readonly string[]): Promise<void> => {
    await client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: { CallerReference: randomUUID(), Paths: { Quantity: paths.length, Items: [...paths] } },
      }),
    );
  };
}
