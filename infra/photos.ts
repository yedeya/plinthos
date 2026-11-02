/**
 * The private photo bucket (brief #6, Issue J and decision 18, `AGENTS.md` §1).
 *
 * - It blocks every kind of public access, and no CloudFront distribution has it as an origin:
 *   the admin sees a stored size only through a presigned GET its server function signs, for a
 *   key under `photos/` ([PHOTO-6]). Its policy only refuses: any request not over TLS.
 * - The phone's presigned POST lands under `quarantine/`, which nothing serves, and a lifecycle
 *   rule expires every object there after one day, the shortest an S3 lifecycle rule can express
 *   ([PHOTO-7]). `registerPhoto` deletes the object it was given within seconds; the rule is the
 *   backstop for a crash. It also drops an unfinished multipart upload after a day.
 * - A CORS rule lets the admin's origin, and only it, POST to the bucket: the browser's upload
 *   goes straight to S3, never through the server function. No other method is allowed, so a
 *   page on another origin can't read an object through it.
 * - The admin's server function is linked to it as `Photos`, with a role that may write, read and
 *   delete only under `quarantine/` (writing there is what lets it sign the phone's upload) and
 *   `photos/`, and list the bucket, so a missing key reads as missing (`src/server/photos/aws.ts`).
 *
 * At rest this costs the stored photos, about $0.02 a month for 1 GB (brief #6, §4): the
 * lifecycle expirations and the CORS rule are free. There is no versioning, which would keep
 * every deleted photo, no logging bucket and no customer-managed key.
 */

/** The prefix the phone uploads into, which nothing serves and the lifecycle rule empties. */
export const QUARANTINE_PREFIX = 'quarantine/';

/** The prefix the re-encoded sizes are stored under. */
export const STORED_PREFIX = 'photos/';

/** How long an object may stay in the quarantine: one day, S3's shortest lifecycle expiry. */
export const QUARANTINE_EXPIRY_DAYS = 1;

export function createPhotos() {
  const bucket = new aws.s3.Bucket('Photos', {});
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock('PhotosPublicAccessBlock', {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  const lifecycle = new aws.s3.BucketLifecycleConfiguration('PhotosQuarantineExpiry', {
    bucket: bucket.id,
    rules: [
      {
        id: 'expire-quarantine',
        status: 'Enabled',
        filter: { prefix: QUARANTINE_PREFIX },
        expiration: { days: QUARANTINE_EXPIRY_DAYS },
        abortIncompleteMultipartUpload: { daysAfterInitiation: QUARANTINE_EXPIRY_DAYS },
      },
    ],
  });

  const policy = new aws.s3.BucketPolicy(
    'PhotosPolicy',
    {
      bucket: bucket.id,
      policy: $jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'RefuseUnencryptedTransport',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [bucket.arn, $interpolate`${bucket.arn}/*`],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
        ],
      }),
    },
    { dependsOn: [publicAccessBlock] },
  );

  const link = new sst.Linkable('Photos', {
    properties: { bucket: bucket.bucket },
    include: [
      sst.aws.permission({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [$interpolate`${bucket.arn}/${QUARANTINE_PREFIX}*`, $interpolate`${bucket.arn}/${STORED_PREFIX}*`],
      }),
      sst.aws.permission({ actions: ['s3:ListBucket'], resources: [bucket.arn] }),
    ],
  });

  /** Lets the admin's origin, and only it, post an upload to the bucket. Called once the admin exists. */
  function allowUploadsFrom(adminUrl: $util.Input<string>) {
    return new aws.s3.BucketCorsConfiguration('PhotosUploadCors', {
      bucket: bucket.id,
      corsRules: [{ allowedOrigins: [adminUrl], allowedMethods: ['POST'], allowedHeaders: [], maxAgeSeconds: 3000 }],
    });
  }

  return { bucket, publicAccessBlock, lifecycle, policy, link, allowUploadsFrom };
}
