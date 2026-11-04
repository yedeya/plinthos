import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerGuards } from '../../infra/guards';
import { SET_INDEX_CRON, SET_INDEX_HANDLER, SET_INDEX_PREFIX, SET_INDEX_SCHEDULE, setIndexBuilderName } from '../../infra/set-index';
import { SET_INDEX_PREFIX as SERVER_PREFIX } from '../../src/server/catalogue/set-index/format';
import { READER_LINK, WRITER_LINK } from '../../src/server/catalogue/set-index/s3';
import { repoRoot } from '../support/repo-file';
import { installFakeSst, type FakeSst } from './fake-sst';
import { runStack } from './harness';

/**
 * The set index's builder, its schedule and its permissions (brief #252, Issue A, [CAT-6] to
 * [CAT-8]): `infra/set-index.ts`, through the whole stack against the stand-ins. Every ARN is
 * made up.
 */

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

function named(type: string, name: string) {
  const found = fake.ofType(type).filter((resource) => resource.name === name);
  expect(found, `${type} ${name}`).toHaveLength(1);
  const [resource] = found;
  if (resource === undefined) throw new Error(`no ${type} ${name}`);
  return resource;
}

const PHOTOS_ARN = 'arn:fake:aws:s3/bucket:Bucket:Photos';

describe('the set index’s builder', () => {
  it('[CAT-8] runs the builder’s handler on Node 24 and arm64, with 512 MB, a 2-minute timeout and no retry, and no URL', () => {
    runStack(fake);
    const { args } = named('sst:aws:Function', 'SetIndexBuilder');
    expect(args).toMatchObject({
      name: setIndexBuilderName({ name: 'plinthos', stage: 'production' }),
      handler: SET_INDEX_HANDLER,
      runtime: 'nodejs24.x',
      architecture: 'arm64',
      memory: '512 MB',
      timeout: '2 minutes',
      retries: 0,
    });
    for (const key of ['url', 'concurrency', 'vpc', 'dev', 'streaming', 'policies', 'permissions', 'environment']) expect(args, key).not.toHaveProperty(key);
    const module = SET_INDEX_HANDLER.slice(0, SET_INDEX_HANDLER.lastIndexOf('.'));
    expect(existsSync(join(repoRoot, `${module}.ts`))).toBe(true);
    expect(SET_INDEX_HANDLER.slice(SET_INDEX_HANDLER.lastIndexOf('.') + 1)).toBe('handler');
  });

  it('[CAT-6] [CAT-8] is linked to no database and no secret: to the index’s prefix of the photo bucket alone', () => {
    runStack(fake);
    const { args } = named('sst:aws:Function', 'SetIndexBuilder');
    const writer = named('sst:sst:Linkable', WRITER_LINK);
    expect(args.link).toEqual([writer.instance]);
    const [database] = fake.ofType('sst:aws:Aurora');
    const secrets = fake.ofType('sst:sst:Secret').map((secret) => secret.instance);
    for (const linked of args.link as object[]) {
      expect(linked).not.toBe(database?.instance);
      expect(secrets).not.toContain(linked);
    }
  });

  it('[CAT-7] [CAT-8] may write, read and delete only under set-index/, and list the bucket only under that prefix', () => {
    runStack(fake);
    expect(SET_INDEX_PREFIX).toBe('set-index/');
    expect(SERVER_PREFIX).toBe(SET_INDEX_PREFIX);
    const writer = named('sst:sst:Linkable', WRITER_LINK);
    expect(writer.args.properties).toEqual({ bucket: 'fake-bucket-Photos' });
    expect(writer.args.include).toEqual([
      { type: 'aws.permission', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [`${PHOTOS_ARN}/set-index/*`] },
      { type: 'aws.permission', actions: ['s3:ListBucket'], resources: [PHOTOS_ARN], conditions: [{ test: 'StringLike', variable: 's3:prefix', values: ['set-index/*'] }] },
    ]);
    // Only the builder holds it.
    for (const resource of fake.resources.filter((candidate) => candidate.name !== 'SetIndexBuilder')) {
      expect((resource.args.link as object[] | undefined) ?? [], resource.name).not.toContain(writer.instance);
    }
  });

  it('[CAT-9] lets the admin read under set-index/, and nothing more of it', () => {
    runStack(fake);
    const reader = named('sst:sst:Linkable', READER_LINK);
    expect(reader.args.properties).toEqual({ bucket: 'fake-bucket-Photos' });
    expect(reader.args.include).toEqual([{ type: 'aws.permission', actions: ['s3:GetObject'], resources: [`${PHOTOS_ARN}/set-index/*`] }]);
    const [admin] = fake.ofType('sst:aws:Nextjs');
    expect(admin?.args.link as object[]).toContain(reader.instance);
    // No other grant reaches the prefix: the Photos link names its own prefixes alone.
    const photos = named('sst:sst:Linkable', 'Photos');
    expect(JSON.stringify(photos.args.include)).not.toContain('set-index');
  });
});

describe('the set index’s schedule', () => {
  it('[CAT-8] runs the builder once a week, on Monday at 08:00 UTC, with no retry', () => {
    runStack(fake);
    expect(SET_INDEX_SCHEDULE).toBe('cron(0 8 ? * MON *)');
    const builder = named('sst:aws:Function', 'SetIndexBuilder');
    const crons = fake.ofType('sst:aws:CronV2');
    expect(crons.map(({ name }) => name)).toEqual([SET_INDEX_CRON]);
    expect(crons[0]?.args).toEqual({ function: (builder.instance as { arn: string }).arn, schedule: SET_INDEX_SCHEDULE, retries: 0 });
  });

  it('[CAT-8] is the one schedule the cost guard lets through, and only as this weekly schedule', () => {
    registerGuards();
    const guards = fake.transforms.filter((transform) => transform.type === 'aws:scheduler/schedule:Schedule');
    expect(guards.length).toBeGreaterThan(0);
    const construct = (args: Record<string, unknown>, name: string) => {
      for (const guard of guards) guard.callback(args, {}, name);
    };
    // CronV2 names its schedule after itself.
    expect(() => construct({ scheduleExpression: SET_INDEX_SCHEDULE }, `${SET_INDEX_CRON}Schedule`)).not.toThrow();
    expect(() => construct({ scheduleExpression: 'rate(1 hour)' }, `${SET_INDEX_CRON}Schedule`)).toThrow(/\[PLAT-7\]/);
    expect(() => construct({ scheduleExpression: 'cron(0 8 ? * * *)' }, `${SET_INDEX_CRON}Schedule`)).toThrow(/\[PLAT-7\]/);
    expect(() => construct({ scheduleExpression: SET_INDEX_SCHEDULE }, 'AnotherSchedule')).toThrow(/\[PLAT-7\]/);
    expect(() => construct({ scheduleExpression: SET_INDEX_SCHEDULE }, `${SET_INDEX_CRON}Schedule2`)).toThrow(/\[PLAT-7\]/);
  });
});

describe('the set index stays private', () => {
  it('[CAT-8] no distribution has the photo bucket as an origin', () => {
    runStack(fake);
    for (const distribution of fake.ofType('aws:cloudfront/distribution:Distribution')) {
      expect(JSON.stringify(distribution.args.origins)).not.toContain('fake-bucket-Photos');
    }
  });

  it('[CAT-8] no page of the public catalogue names the index', () => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(repoRoot, 'src/server/publish'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(repoRoot, file)).not.toMatch(/set-index|setIndex|sets\/index/);
    }
  });
});
