/**
 * The public catalogue's path: a private bucket that holds the snapshots, and a CloudFront
 * distribution of its own whose only origin is that bucket (brief #6, decision 15). No public path
 * can reach a Lambda function or the database, by construction ([PUB-1]); the admin's
 * distribution is a separate one, which `sst.aws.Nextjs` creates (`infra/admin.ts`).
 *
 * - The bucket blocks every kind of public access. Its policy lets this distribution, and nothing
 *   else, read objects under `c/`, through origin access control, which signs every request.
 *   It grants no `s3:ListBucket`, so a request for `/`, for `/c/` or for an unknown token gets
 *   S3's 403 and never a listing ([PUB-2]).
 * - Every response carries `X-Robots-Tag: noindex`, from a response-headers policy ([PUB-2]),
 *   with `Referrer-Policy: no-referrer`, because the address holds the token.
 * - The admin's server function is linked to it as `Snapshot`, with a role that may read, write
 *   and delete only under `c/`, list the bucket (so a missing key reads as missing) and invalidate
 *   only this distribution (`src/server/publish/aws.ts`).
 *
 * At rest this costs the snapshot's storage, a few kilobytes, so about $0. Requests, transfer and
 * the first 1,000 invalidation paths a month fall inside the always-free tiers at this volume
 * (brief #6, §4). There is no custom domain (decision 8), no logging bucket and no WAF.
 */

/** The prefix the distribution may read, and the only one the publish step writes. */
export const SNAPSHOT_PREFIX = 'c';

/** AWS's managed `CachingOptimized` cache policy: no cookie, header or query string in the key. */
export const CACHING_OPTIMIZED_POLICY_ID = '658327ea-f89d-4fab-a63d-7e88639e58f6';

/** The origin's id inside the distribution. */
export const SNAPSHOT_ORIGIN_ID = 'snapshot-bucket';

export function createSnapshot() {
  const bucket = new aws.s3.Bucket('Snapshot', {});
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock('SnapshotPublicAccessBlock', {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  const originAccessControl = new aws.cloudfront.OriginAccessControl('SnapshotOriginAccessControl', {
    name: `${$app.name}-${$app.stage}-snapshot`,
    description: 'The public catalogue distribution reads the snapshot bucket, signing every request.',
    originAccessControlOriginType: 's3',
    signingBehavior: 'always',
    signingProtocol: 'sigv4',
  });

  const headers = new aws.cloudfront.ResponseHeadersPolicy('SnapshotHeaders', {
    name: `${$app.name}-${$app.stage}-snapshot`,
    comment: 'noindex on every response of the public catalogue (PUB-2)',
    customHeadersConfig: { items: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }] },
    securityHeadersConfig: {
      referrerPolicy: { referrerPolicy: 'no-referrer', override: true },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: 'DENY', override: true },
      strictTransportSecurity: { accessControlMaxAgeSec: 31536000, includeSubdomains: true, override: true },
    },
  });

  const distribution = new aws.cloudfront.Distribution('SnapshotDistribution', {
    enabled: true,
    comment: `${$app.name} ${$app.stage}: the public catalogue snapshot`,
    isIpv6Enabled: true,
    httpVersion: 'http2and3',
    // Europe and North America only: the cheapest class, and where buyers of this lot are.
    priceClass: 'PriceClass_100',
    origins: [
      {
        originId: SNAPSHOT_ORIGIN_ID,
        domainName: bucket.bucketRegionalDomainName,
        originAccessControlId: originAccessControl.id,
        // Origin access control, not the legacy origin access identity.
        s3OriginConfig: { originAccessIdentity: '' },
      },
    ],
    defaultCacheBehavior: {
      targetOriginId: SNAPSHOT_ORIGIN_ID,
      viewerProtocolPolicy: 'redirect-to-https',
      allowedMethods: ['GET', 'HEAD'],
      cachedMethods: ['GET', 'HEAD'],
      compress: true,
      cachePolicyId: CACHING_OPTIMIZED_POLICY_ID,
      responseHeadersPolicyId: headers.id,
    },
    restrictions: { geoRestriction: { restrictionType: 'none' } },
    viewerCertificate: { cloudfrontDefaultCertificate: true },
  });

  const policy = new aws.s3.BucketPolicy(
    'SnapshotPolicy',
    {
      bucket: bucket.id,
      policy: $jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'PublicDistributionReadsSnapshots',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: $interpolate`${bucket.arn}/${SNAPSHOT_PREFIX}/*`,
            Condition: { StringEquals: { 'AWS:SourceArn': distribution.arn } },
          },
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
    // The block must be in place before any policy exists, so the policy can never be public.
    { dependsOn: [publicAccessBlock] },
  );

  const link = new sst.Linkable('Snapshot', {
    properties: {
      bucket: bucket.bucket,
      distributionId: distribution.id,
      url: $interpolate`https://${distribution.domainName}`,
    },
    include: [
      sst.aws.permission({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [$interpolate`${bucket.arn}/${SNAPSHOT_PREFIX}/*`],
      }),
      sst.aws.permission({ actions: ['s3:ListBucket'], resources: [bucket.arn] }),
      sst.aws.permission({ actions: ['cloudfront:CreateInvalidation'], resources: [distribution.arn] }),
    ],
  });

  return { bucket, publicAccessBlock, originAccessControl, headers, distribution, policy, link };
}
