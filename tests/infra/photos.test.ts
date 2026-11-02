import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_ARCHITECTURE, SERVER_MEMORY, SERVER_TIMEOUT, SERVER_TIMEOUT_SECONDS } from '../../infra/admin';
import {
  DEFAULT_PHOTO_LONGEST_EDGE,
  DEFAULT_PHOTO_MAX_BYTES,
  DeploymentConfigError,
  PHOTO_LONGEST_EDGE_RANGE,
  PHOTO_MAX_BYTES_RANGE,
  readDeploymentConfig,
} from '../../infra/config';
import { QUARANTINE_EXPIRY_DAYS, QUARANTINE_PREFIX, STORED_PREFIX } from '../../infra/photos';
import openNextConfig, { SHARP_VERSION } from '../../open-next.config';
import { REPLAY_TIMEOUT_MS } from '../../src/app/_offline/replay';
import * as server from '../../src/server/photos/config';
import { QUARANTINE_PREFIX as SERVER_QUARANTINE_PREFIX, STORED_PREFIX as SERVER_STORED_PREFIX } from '../../src/server/photos/keys';
import { MAX_PHOTOS_PER_BATCH, PHOTO_BUDGET_MS } from '../../src/server/sync/limits';
import { readRepoFile } from '../support/repo-file';
import { installFakeSst, type FakeSst, type RecordedResource } from './fake-sst';
import { deploymentEnv, runStack } from './harness';

/**
 * The private photo bucket (`infra/photos.ts`, #22). `[PHOTO-6]`: it blocks all public access, no
 * distribution has it as an origin, and its policy only refuses. `[PHOTO-7]`: a lifecycle rule
 * expires everything under the quarantine prefix after one day, and nothing serves that prefix.
 * `docs/qa/stack.md`'s `## Data isolation` holds this file: a read or an origin on the quarantine
 * prefix, or a longer lifecycle on it, is a regression. What S3 itself does with these rules only
 * a deployment shows (Issue K).
 */

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

function named(type: string, name: string): RecordedResource {
  const found = fake.ofType(type).filter((resource) => resource.name === name);
  expect(found, `${type} ${name}`).toHaveLength(1);
  return found[0] as RecordedResource;
}

const photos = () => named('aws:s3/bucket:Bucket', 'Photos');

describe('the photo bucket', () => {
  it('[PHOTO-6] blocks every kind of public access, before its policy exists, and is no website', () => {
    runStack(fake);
    const block = named('aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock', 'PhotosPublicAccessBlock');
    expect(block.args).toEqual({
      bucket: (photos().instance as { id: string }).id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(named('aws:s3/bucketPolicy:BucketPolicy', 'PhotosPolicy').opts?.dependsOn).toEqual([block.instance]);
    expect(photos().args).toEqual({});
  });

  it('[PHOTO-6] [PHOTO-7] is the origin of no distribution, and its policy allows nothing: it only refuses requests not over TLS', () => {
    runStack(fake);
    const bucket = photos().instance as { bucket: string; bucketRegionalDomainName: string; arn: string };
    for (const distribution of fake.ofType('aws:cloudfront/distribution:Distribution')) {
      expect(JSON.stringify(distribution.args)).not.toContain(bucket.bucket);
    }
    for (const control of fake.ofType('aws:cloudfront/originAccessControl:OriginAccessControl')) expect(control.name).not.toMatch(/photo/i);
    const policy = JSON.parse(String(named('aws:s3/bucketPolicy:BucketPolicy', 'PhotosPolicy').args.policy)) as { Statement: { Effect: string }[] };
    expect(policy.Statement.map(({ Effect }) => Effect)).toEqual(['Deny']);
    expect(policy.Statement[0]).toMatchObject({ Principal: '*', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } });
  });

  it('[PHOTO-7] expires every object under the quarantine prefix after one day, and nothing else', () => {
    runStack(fake);
    const lifecycle = named('aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration', 'PhotosQuarantineExpiry');
    expect(lifecycle.args).toEqual({
      bucket: (photos().instance as { id: string }).id,
      rules: [
        {
          id: 'expire-quarantine',
          status: 'Enabled',
          filter: { prefix: 'quarantine/' },
          expiration: { days: 1 },
          abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
        },
      ],
    });
    expect(QUARANTINE_EXPIRY_DAYS).toBe(1);
    // The server makes its keys under the same prefixes the bucket's rules name.
    expect([QUARANTINE_PREFIX, STORED_PREFIX]).toEqual([SERVER_QUARANTINE_PREFIX, SERVER_STORED_PREFIX]);
    expect(fake.ofType('aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration')).toHaveLength(1);
  });

  it('[PHOTO-7] lets only the admin’s origin post an upload to it, with no other method', () => {
    const { outputs } = runStack(fake);
    const cors = named('aws:s3/bucketCorsConfiguration:BucketCorsConfiguration', 'PhotosUploadCors');
    expect(cors.args).toEqual({
      bucket: (photos().instance as { id: string }).id,
      corsRules: [{ allowedOrigins: [outputs.adminUrl], allowedMethods: ['POST'], allowedHeaders: [], maxAgeSeconds: 3000 }],
    });
  });

  it('[PHOTO-6] [PHOTO-7] lets the admin write, read and delete only under the two prefixes, and list the bucket', () => {
    runStack(fake);
    const bucket = photos().instance as { arn: string; bucket: string };
    const link = named('sst:sst:Linkable', 'Photos');
    expect(link.args.properties).toEqual({ bucket: bucket.bucket });
    expect(link.args.include).toEqual([
      {
        type: 'aws.permission',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`${bucket.arn}/quarantine/*`, `${bucket.arn}/photos/*`],
      },
      { type: 'aws.permission', actions: ['s3:ListBucket'], resources: [bucket.arn] },
    ]);
    expect((named('sst:aws:Nextjs', 'Admin').args.link as object[])).toContain(link.instance);
  });

  it('[PHOTO-6] prints nothing of the bucket after a deploy', () => {
    const { outputs } = runStack(fake);
    expect(JSON.stringify(outputs)).not.toContain((photos().instance as { bucket: string }).bucket);
  });
});

describe('the admin’s server function, for the re-encoding', () => {
  it('[PHOTO-3] runs on arm64 with the memory sharp needs, and OpenNext installs the sharp version the tests ran, for Linux arm64', () => {
    runStack(fake);
    expect(named('sst:aws:Nextjs', 'Admin').args.server).toMatchObject({ architecture: SERVER_ARCHITECTURE, memory: SERVER_MEMORY });
    expect(SERVER_ARCHITECTURE).toBe('arm64');
    const pinned = (JSON.parse(readRepoFile('package.json')) as { dependencies: Record<string, string> }).dependencies.sharp;
    expect(SHARP_VERSION).toBe(pinned);
    expect(openNextConfig.default.install).toEqual({ packages: [`sharp@${pinned}`], arch: 'arm64', os: 'linux', libc: 'glibc' });
  });

  it('[SYNC-10] has its timeout set explicitly, inside CloudFront’s and the phone’s, and long enough for a batch’s photos (#95)', () => {
    runStack(fake);
    expect(named('sst:aws:Nextjs', 'Admin').args.server).toMatchObject({ timeout: SERVER_TIMEOUT });
    expect(SERVER_TIMEOUT).toBe(`${SERVER_TIMEOUT_SECONDS} seconds`);
    // SST makes CloudFront wait for the server origin as long as this timeout, and CloudFront's
    // origin response timeout goes no higher than 60 seconds without a quota increase.
    expect(SERVER_TIMEOUT_SECONDS).toBeLessThanOrEqual(60);
    const timeoutMs = SERVER_TIMEOUT_SECONDS * 1000;
    expect(timeoutMs).toBeLessThan(REPLAY_TIMEOUT_MS);
    expect(MAX_PHOTOS_PER_BATCH * PHOTO_BUDGET_MS).toBeLessThan(timeoutMs);
    expect(MAX_PHOTOS_PER_BATCH * PHOTO_BUDGET_MS).toBeLessThan(REPLAY_TIMEOUT_MS);
  });

  it('[PHOTO-1] receives the longest edge and the size cap from the deployment’s configuration, with the server’s defaults', () => {
    runStack(fake);
    expect(named('sst:aws:Nextjs', 'Admin').args.environment).toMatchObject({ [server.LONGEST_EDGE_ENV]: '2048', [server.MAX_BYTES_ENV]: '4194304' });
    fake.uninstall();
    fake = installFakeSst();
    runStack(fake, deploymentEnv({ PLINTHOS_PHOTO_LONGEST_EDGE: '1600', PLINTHOS_PHOTO_MAX_BYTES: '2000000' }));
    expect(named('sst:aws:Nextjs', 'Admin').args.environment).toMatchObject({ [server.LONGEST_EDGE_ENV]: '1600', [server.MAX_BYTES_ENV]: '2000000' });
    // The stack and the server agree on the defaults and the bounds.
    expect([Number(DEFAULT_PHOTO_LONGEST_EDGE), Number(DEFAULT_PHOTO_MAX_BYTES)]).toEqual([server.DEFAULT_LONGEST_EDGE, server.DEFAULT_MAX_BYTES]);
    expect(PHOTO_LONGEST_EDGE_RANGE).toEqual(server.LONGEST_EDGE_RANGE);
    expect(PHOTO_MAX_BYTES_RANGE).toEqual(server.MAX_BYTES_RANGE);
  });

  it('[PHOTO-1] [PLAT-2] refuses a longest edge or a size cap that is not a whole number within its bounds', () => {
    const region = { PLINTHOS_AWS_REGION: 'eu-west-1' };
    for (const bad of ['0', '100', '9000', '2048.5', 'big']) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_PHOTO_LONGEST_EDGE: bad }), bad).toThrow(DeploymentConfigError);
    }
    for (const bad of ['0', '1000', '30000000', '1e6']) {
      expect(() => readDeploymentConfig({ ...region, PLINTHOS_PHOTO_MAX_BYTES: bad }), bad).toThrow(/PLINTHOS_PHOTO_MAX_BYTES/);
    }
  });
});
