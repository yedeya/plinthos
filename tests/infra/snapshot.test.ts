import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_ORIGIN_ID, SNAPSHOT_PREFIX } from '../../infra/snapshot';
import { LEASE_WAIT, PUBLISH_LEASE_SECONDS } from '../../src/server/publish/projection';
import { SNAPSHOT_PREFIX as WRITER_PREFIX } from '../../src/server/publish/snapshot';
import { installFakeSst, type FakeSst, type RecordedResource } from './fake-sst';
import { runStack } from './harness';

/**
 * `[PUB-1]`: the public catalogue is served by a distribution whose only origin is the private
 * snapshot bucket, through origin access control, with no dynamic origin, and the bucket blocks
 * all public access. `[PUB-2]`: every response carries `X-Robots-Tag: noindex`, and nothing
 * lists the bucket. `docs/qa/stack.md`'s `## Data isolation` holds this file: a change that adds
 * a dynamic origin to the public distribution is a regression.
 */

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

/**
 * The one resource of a type the snapshot module creates, by its logical name: the photo bucket
 * (`infra/photos.ts`, #22) is a second bucket, block, policy and link, and its own tests hold it.
 * The admin's component is the stack's only one of its type.
 */
function one(type: string): RecordedResource {
  const found = fake.ofType(type).filter((resource) => type === 'sst:aws:Nextjs' || resource.name.startsWith('Snapshot'));
  expect(found, type).toHaveLength(1);
  return found[0] as RecordedResource;
}

type Statement = { Sid?: string; Effect: string; Principal: unknown; Action: string | string[]; Resource: unknown; Condition?: unknown };

function policyStatements(): Statement[] {
  const policy = one('aws:s3/bucketPolicy:BucketPolicy');
  return (JSON.parse(String(policy.args.policy)) as { Statement: Statement[] }).Statement;
}

describe('the public distribution', () => {
  it('[PUB-1] is the only distribution the stack defines, and its one origin is the snapshot bucket through origin access control', () => {
    runStack(fake);
    expect(fake.ofType('aws:cloudfront/distribution:Distribution')).toHaveLength(1);
    const bucket = one('aws:s3/bucket:Bucket').instance as { bucketRegionalDomainName: string };
    const control = one('aws:cloudfront/originAccessControl:OriginAccessControl');
    const distribution = one('aws:cloudfront/distribution:Distribution');
    const origins = distribution.args.origins as Record<string, unknown>[];
    expect(origins).toHaveLength(1);
    expect(origins[0]).toEqual({
      originId: SNAPSHOT_ORIGIN_ID,
      domainName: bucket.bucketRegionalDomainName,
      originAccessControlId: (control.instance as { id: string }).id,
      s3OriginConfig: { originAccessIdentity: '' },
    });
    expect(control.args).toMatchObject({ originAccessControlOriginType: 's3', signingBehavior: 'always', signingProtocol: 'sigv4' });
  });

  it('[PUB-1] has no dynamic origin: no origin group, no other behavior, and no function at the edge', () => {
    runStack(fake);
    const distribution = one('aws:cloudfront/distribution:Distribution');
    expect(distribution.args).not.toHaveProperty('originGroups');
    expect(distribution.args).not.toHaveProperty('orderedCacheBehaviors');
    const behavior = distribution.args.defaultCacheBehavior as Record<string, unknown>;
    expect(behavior.targetOriginId).toBe(SNAPSHOT_ORIGIN_ID);
    expect(behavior).not.toHaveProperty('lambdaFunctionAssociations');
    expect(behavior).not.toHaveProperty('functionAssociations');
    expect(behavior).not.toHaveProperty('originRequestPolicyId');
    expect(behavior.allowedMethods).toEqual(['GET', 'HEAD']);
    expect(behavior.viewerProtocolPolicy).toBe('redirect-to-https');
    // The bucket is never a website endpoint, which would be a public, custom origin.
    expect(one('aws:s3/bucket:Bucket').args).not.toHaveProperty('website');
    expect(fake.ofType('aws:s3/bucketWebsiteConfiguration:BucketWebsiteConfiguration')).toEqual([]);
  });

  it('[PUB-1] blocks every kind of public access on the bucket, before its policy exists', () => {
    runStack(fake);
    const bucket = one('aws:s3/bucket:Bucket');
    const block = one('aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock');
    expect(block.args).toEqual({
      bucket: (bucket.instance as { id: string }).id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    const policy = one('aws:s3/bucketPolicy:BucketPolicy');
    expect(policy.opts?.dependsOn).toEqual([block.instance]);
  });

  it('[PUB-1] lets this distribution, and only it, read objects under the snapshot prefix, and nothing else', () => {
    runStack(fake);
    const bucket = one('aws:s3/bucket:Bucket').instance as { arn: string };
    const distribution = one('aws:cloudfront/distribution:Distribution').instance as { arn: string };
    const allows = policyStatements().filter(({ Effect }) => Effect === 'Allow');
    expect(allows).toEqual([
      {
        Sid: 'PublicDistributionReadsSnapshots',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: `${bucket.arn}/${SNAPSHOT_PREFIX}/*`,
        Condition: { StringEquals: { 'AWS:SourceArn': distribution.arn } },
      },
    ]);
    // Every other statement only refuses.
    for (const statement of policyStatements()) expect(['Allow', 'Deny']).toContain(statement.Effect);
    expect(SNAPSHOT_PREFIX).toBe(WRITER_PREFIX);
  });
});

describe('what the public distribution answers', () => {
  it('[PUB-2] sends X-Robots-Tag: noindex on every response, overriding the origin, and no referrer', () => {
    runStack(fake);
    const headers = one('aws:cloudfront/responseHeadersPolicy:ResponseHeadersPolicy');
    const custom = (headers.args.customHeadersConfig as { items: Record<string, unknown>[] }).items;
    expect(custom).toContainEqual({ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true });
    const security = headers.args.securityHeadersConfig as Record<string, Record<string, unknown>>;
    expect(security.referrerPolicy).toEqual({ referrerPolicy: 'no-referrer', override: true });
    // The one behavior there is uses it.
    const behavior = one('aws:cloudfront/distribution:Distribution').args.defaultCacheBehavior as Record<string, unknown>;
    expect(behavior.responseHeadersPolicyId).toBe((headers.instance as { id: string }).id);
  });

  it('[PUB-2] never lists the bucket: no root object, no error page, and no s3:ListBucket for the distribution', () => {
    runStack(fake);
    const distribution = one('aws:cloudfront/distribution:Distribution');
    expect(distribution.args).not.toHaveProperty('defaultRootObject');
    expect(distribution.args).not.toHaveProperty('customErrorResponses');
    for (const { Effect, Action } of policyStatements()) {
      if (Effect !== 'Allow') continue;
      for (const action of [Action].flat()) expect(action).toBe('s3:GetObject');
    }
  });
});

describe('the admin’s link to the snapshot', () => {
  it('[PUB-6] lets the admin write only under the snapshot prefix and invalidate only this distribution', () => {
    runStack(fake);
    const link = one('sst:sst:Linkable');
    const bucket = one('aws:s3/bucket:Bucket').instance as { arn: string; bucket: string };
    const distribution = one('aws:cloudfront/distribution:Distribution').instance as { arn: string; id: string; domainName: string };
    expect(link.name).toBe('Snapshot');
    expect(link.args.properties).toEqual({
      bucket: bucket.bucket,
      distributionId: distribution.id,
      url: `https://${distribution.domainName}`,
    });
    expect(link.args.include).toEqual([
      { type: 'aws.permission', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [`${bucket.arn}/${SNAPSHOT_PREFIX}/*`] },
      { type: 'aws.permission', actions: ['s3:ListBucket'], resources: [bucket.arn] },
      { type: 'aws.permission', actions: ['cloudfront:CreateInvalidation'], resources: [distribution.arn] },
    ]);
    const admin = one('sst:aws:Nextjs');
    expect(admin.args.link).toContain(link.instance);
  });

  it('[PUB-8] a publish’s turn outlasts the server function that runs it, and its wait leaves it time to publish', () => {
    runStack(fake);
    const server = one('sst:aws:Nextjs').args.server as { timeout?: string };
    // `infra/admin.ts` sets no timeout, so the function has SST's default for a Nextjs server
    // (`.sst/platform/src/components/aws/ssr-site.ts`): 20 seconds.
    const match = /^(\d+) (second|minute)s?$/.exec(server.timeout ?? '20 seconds');
    const seconds = Number(match?.[1]) * (match?.[2] === 'minute' ? 60 : 1);
    expect(seconds).toBeGreaterThan(0);
    // Lambda stops the function at its timeout, so no publish is still writing when its turn runs out.
    expect(PUBLISH_LEASE_SECONDS).toBeGreaterThanOrEqual(3 * seconds);
    expect((LEASE_WAIT.attempts * LEASE_WAIT.ms) / 1000).toBeLessThanOrEqual(seconds / 2);
  });

  it('[PUB-6] prints the catalogue’s host after a deploy, never an ARN or the token', () => {
    const { outputs } = runStack(fake);
    const distribution = one('aws:cloudfront/distribution:Distribution').instance as { domainName: string };
    expect(outputs).toEqual({ adminUrl: 'https://admin.example.test', catalogueHost: `https://${distribution.domainName}` });
  });
});
