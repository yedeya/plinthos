/**
 * `publishCatalogue`: the one publish step, a typed service function only the signed-in admin can
 * call (`AGENTS.md` §4, [PUB-6]).
 *
 * It reads the database once, through the public projection ([PUB-5]), makes the catalogue token
 * on the first publish, writes the snapshot under `c/{token}/` in the private bucket and
 * invalidates only that path on the public distribution. Public pages never query the database:
 * they are the files this writes.
 *
 * A publish that fails leaves the previous snapshot in place and says so to the admin who started
 * it ([OPS-6]): nothing is written before the projection is complete, and a failed write or a
 * failed invalidation puts every file back as it was. It logs `catalogue.published` or
 * `catalogue.publish.failed` (`docs/observability.md`), never the token: an error from S3 can name
 * the object's key, so its message is logged with the token taken out.
 */
import { z } from 'zod';
import { adminOperation } from '../auth/admin-context';
import { database } from '../database';
import { logger, type Logger } from '../logger';
import { cloudFrontInvalidator, s3SnapshotStore, snapshotResource } from './aws';
import { readPublication, type PublishDatabase } from './projection';
import { snapshotPath, SnapshotWriteError, writeSnapshot, type SnapshotStore, type WrittenSnapshot } from './snapshot';

/** The placeholder publish takes no options. */
export const PublishInput = z.object({}).strict();

export type PublishResult =
  | { readonly status: 'published'; readonly url: string; readonly publishedAt: string }
  | {
      readonly status: 'failed';
      readonly requestId: string;
      /** Whether the previous snapshot is still the one served. */
      readonly previousKept: boolean;
    };

export interface PublishDependencies {
  readonly database: () => PublishDatabase;
  readonly store: () => SnapshotStore;
  /** Drops the distribution's copies of the paths. */
  readonly invalidate: (paths: readonly string[]) => Promise<void>;
  /** The public distribution's address, such as `https://d111111abcdef8.cloudfront.net`. */
  readonly publicUrl: () => string;
  readonly now?: () => Date;
  readonly log?: Logger;
}

type Stage = 'read' | 'write' | 'invalidate';

/** Builds `publishCatalogue` over its stores; deployed code uses `publishCatalogue` below. */
export function createPublishCatalogue(dependencies: PublishDependencies) {
  const log = dependencies.log ?? logger;
  const now = dependencies.now ?? (() => new Date());

  return adminOperation(PublishInput, async (admin): Promise<PublishResult> => {
    let stage: Stage = 'read';
    let token: string | undefined;
    let written: WrittenSnapshot | undefined;
    try {
      const publication = await readPublication(dependencies.database(), { now: now() });
      token = publication.token;
      stage = 'write';
      written = await writeSnapshot(dependencies.store(), publication.token, publication.projection);
      stage = 'invalidate';
      const path = snapshotPath(publication.token);
      await dependencies.invalidate([path, `${path}*`]);
      const { publishedAt } = publication.projection.catalogue;
      log.info(
        { businessEvent: 'catalogue.published', requestId: admin.requestId, files: written.files, bytes: written.bytes, publishedAt },
        'Published the catalogue.',
      );
      return { status: 'published', url: `${dependencies.publicUrl().replace(/\/+$/, '')}${path}`, publishedAt };
    } catch (error) {
      const previousKept = await keptPrevious(stage, error, written);
      log.error(
        { businessEvent: 'catalogue.publish.failed', requestId: admin.requestId, stage, previousKept, failure: describe(error, token) },
        'Publishing the catalogue failed.',
      );
      return { status: 'failed', requestId: admin.requestId, previousKept };
    }
  });
}

/** Whether the previous snapshot is still the one in the bucket after a failure at `stage`. */
async function keptPrevious(stage: Stage, error: unknown, written: WrittenSnapshot | undefined): Promise<boolean> {
  if (stage === 'read') return true;
  if (stage === 'write') return error instanceof SnapshotWriteError && error.restored;
  // The files were written but the distribution may keep serving them stale, or not: put the old
  // ones back, so the bucket and the distribution agree on the previous snapshot.
  try {
    await written?.restore();
    return true;
  } catch {
    return false;
  }
}

/** The error's name, code and message, and its cause's, with the token taken out. */
function describe(error: unknown, token: string | undefined): Record<string, unknown> {
  const scrub = (text: string) => (token === undefined ? text : text.split(token).join('[token]'));
  const one = (value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: scrub(value.message), ...('Code' in value ? { code: String(value.Code) } : {}) }
      : { message: scrub(String(value)) };
  const cause = error instanceof Error && error.cause !== undefined ? { cause: one(error.cause) } : {};
  return { ...one(error), ...cause };
}

/** The publish step as deployed: the Data API, the snapshot bucket and the public distribution. */
let deployedStore: SnapshotStore | undefined;
let deployedInvalidate: ((paths: readonly string[]) => Promise<void>) | undefined;

export const publishCatalogue = createPublishCatalogue({
  database,
  store: () => (deployedStore ??= s3SnapshotStore(snapshotResource().bucket)),
  invalidate: (paths) => (deployedInvalidate ??= cloudFrontInvalidator(snapshotResource().distributionId))(paths),
  publicUrl: () => snapshotResource().url,
});
