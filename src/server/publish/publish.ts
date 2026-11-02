/**
 * `publishCatalogue` and `rotateCatalogueToken`: the publish step, typed service functions only
 * the signed-in admin can call (`AGENTS.md` §4, [PUB-6], [PUB-15]).
 *
 * A publish reads the database once, through the public projection ([PUB-5]), makes the catalogue
 * token on the first publish, writes the snapshot under `c/{token}/` in the private bucket, its
 * photos copied there under new random paths ([PUB-13]), and invalidates only that path on the
 * public distribution. Then it deletes what the bucket holds that this snapshot doesn't: the
 * previous snapshot's photos and pages. Public pages never query the database: they are the files
 * this writes.
 *
 * A rotation is a publish under a new token ([PUB-15]): it writes the whole snapshot under the new
 * token, then stores the token, then deletes every object under the old one and invalidates the
 * old path, so the old link stops working. It takes the publish's turn ([PUB-8]).
 *
 * A publish that fails leaves the previous snapshot in place and says so to the admin who started
 * it ([OPS-6]): nothing is written before the projection is complete, and a failed write or a
 * failed invalidation puts every file back as it was. A rotation that fails before its new token
 * is stored does the same, and the old token keeps serving. Publishes take turns, so the files put
 * back are the last publish's, never those of one running beside it, and a publish that waited
 * too long for its turn says so ([PUB-8]). It logs `catalogue.published`,
 * `catalogue.token.rotated` or `catalogue.publish.failed` (`docs/observability.md`), never the
 * token: an error from S3 can name the object's key, so its message is logged with the token
 * taken out.
 */
import { z } from 'zod';
import { adminOperation, type AdminContext } from '../auth/admin-context';
import { database } from '../database';
import { logger, type Logger } from '../logger';
import { photosBucket } from '../photos/aws';
import { cloudFrontInvalidator, s3SnapshotStore, snapshotResource } from './aws';
import { NotPublishedError, PublishInProgressError, readPublication, type Publication, type PublishDatabase } from './projection';
import { snapshotPath, SnapshotWriteError, writeSnapshot, type SnapshotStore, type WrittenSnapshot } from './snapshot';
import { generateCatalogueToken, type CatalogueToken } from './token';

/** A publish takes no options. */
export const PublishInput = z.object({}).strict();

/** A republish after a delete takes no options. */
export const RepublishInput = z.object({}).strict();

/**
 * What the public catalogue came to after a delete (#187): `updated`, republished without what
 * was deleted; `stale`, the republish failed and the catalogue still shows it until the owner
 * presses Publish; `not-published`, there is no public catalogue to update.
 */
export type RepublishResult =
  | { readonly catalogue: 'updated' }
  | { readonly catalogue: 'stale'; readonly requestId: string }
  | { readonly catalogue: 'not-published' };

/** A rotation takes no options: the Rotate button's confirmation is the page's. */
export const RotateInput = z.object({}).strict();

export type PublishFailure = {
  readonly status: 'failed';
  readonly requestId: string;
  /** Whether the previous snapshot, under the token as it was, is still the one served. */
  readonly previousKept: boolean;
  /** Another publish was still running for as long as this one waited its turn, so it wrote nothing. */
  readonly busy?: true;
};

export type PublishResult = { readonly status: 'published'; readonly url: string; readonly publishedAt: string } | PublishFailure;

export type RotateResult =
  | {
      readonly status: 'rotated';
      /** The catalogue's new address. */
      readonly url: string;
      readonly publishedAt: string;
      /**
       * Whether every object under the old token was deleted and its path invalidated. When not,
       * the old link may keep working from the distribution's cache for up to a day, and the next
       * publish deletes what is left in the bucket.
       */
      readonly oldRemoved: boolean;
    }
  | PublishFailure;

export interface PublishDependencies {
  readonly database: () => PublishDatabase;
  readonly store: () => SnapshotStore;
  /** Drops the distribution's copies of the paths. */
  readonly invalidate: (paths: readonly string[]) => Promise<void>;
  /** The public distribution's address, such as `https://d111111abcdef8.cloudfront.net`. */
  readonly publicUrl: () => string;
  readonly now?: () => Date;
  /** How a publish waits before it asks again for the turn another one holds. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Makes the rotation's new token; the secure generator unless a test gives another. */
  readonly newToken?: () => CatalogueToken;
  readonly log?: Logger;
}

type Stage = 'read' | 'write' | 'invalidate' | 'token';

interface Done {
  readonly token: CatalogueToken;
  readonly publishedAt: string;
  readonly written: WrittenSnapshot;
  /** For a rotation: the token it replaced, and whether its folder is gone. */
  readonly rotated?: { readonly old: CatalogueToken; readonly removed: boolean };
}

/** Builds the publish step over its stores; deployed code uses `publishCatalogue` and `rotateCatalogueToken` below. */
export function createPublishStep(dependencies: PublishDependencies) {
  const log = dependencies.log ?? logger;
  const now = dependencies.now ?? (() => new Date());
  const newToken = dependencies.newToken ?? generateCatalogueToken;
  const url = (token: CatalogueToken) => `${dependencies.publicUrl().replace(/\/+$/, '')}${snapshotPath(token)}`;

  /**
   * One publish, under the stored token or, for a rotation, a new one. `finish` logs its success
   * and makes its result, inside its turn, so that line comes before any about ending the turn.
   */
  async function run<Result>(
    admin: AdminContext,
    rotate: boolean,
    finish: (done: Done) => Result,
    /** For a republish: what to answer when no catalogue is published, in which case nothing is. */
    notPublished?: () => Result,
  ): Promise<Result | PublishFailure> {
    const republish = notPublished !== undefined;
    let stage: Stage = 'read';
    let tokens: CatalogueToken[] = [];
    let written: WrittenSnapshot | undefined;
    let publication: Publication | undefined;
    try {
      publication = await readPublication(dependencies.database(), { now, sleep: dependencies.sleep, ifPublished: republish });
      const old = publication.token;
      const token = rotate ? newToken() : old;
      tokens = [old, token];
      const store = dependencies.store();
      stage = 'write';
      written = await writeSnapshot(store, token, publication.projection);
      stage = 'invalidate';
      if (!rotate) {
        const path = snapshotPath(token);
        await dependencies.invalidate([path, `${path}*`]);
      } else {
        // Nothing has ever served the new path, so there is nothing to invalidate yet. The new
        // token is stored only now that its snapshot is whole: before this, the old one serves.
        stage = 'token';
        await publication.replaceToken(token);
      }
      const { publishedAt } = publication.projection.catalogue;
      const done = { token, publishedAt, written };
      // The publish has succeeded from here: what follows only tidies up, and a failure in it is
      // logged, never reported as the publish's.
      const removed = await removeStale(admin, written, tokens);
      if (!rotate) return finish(done);
      const oldPath = snapshotPath(old);
      const invalidated = await dependencies.invalidate([oldPath, `${oldPath}*`]).then(
        () => true,
        (error: unknown) => {
          log.warn({ requestId: admin.requestId, failure: describe(error, tokens) }, 'Invalidating the old catalogue path failed.');
          return false;
        },
      );
      return finish({ ...done, rotated: { old, removed: removed && invalidated } });
    } catch (error) {
      if (error instanceof NotPublishedError && notPublished !== undefined) return notPublished();
      const previousKept = await keptPrevious(stage, error, written);
      const fields = { requestId: admin.requestId, stage, rotate, previousKept, failure: describe(error, tokens) };
      if (republish) {
        log.error(
          { businessEvent: 'catalogue.republish.failed', ...fields },
          'Republishing the catalogue after a delete failed: it still shows what was deleted until the next publish.',
        );
      } else {
        log.error({ businessEvent: 'catalogue.publish.failed', ...fields }, 'Publishing the catalogue failed.');
      }
      return { status: 'failed', requestId: admin.requestId, previousKept, ...(error instanceof PublishInProgressError ? { busy: true as const } : {}) };
    } finally {
      // Only after the files are put back, so the next publish reads the snapshot this one left.
      await publication?.release().catch((error: unknown) => {
        log.warn({ requestId: admin.requestId, failure: describe(error, tokens) }, 'Ending the publish’s turn failed: it runs out on its own.');
      });
    }
  }

  /** Deletes what the bucket holds that this snapshot doesn't; answers whether that worked. */
  async function removeStale(admin: AdminContext, written: WrittenSnapshot, tokens: readonly string[]): Promise<boolean> {
    try {
      await written.removeStale();
      return true;
    } catch (error) {
      log.warn({ requestId: admin.requestId, failure: describe(error, tokens) }, 'Deleting the previous snapshot’s files failed: the next publish deletes them.');
      return false;
    }
  }

  const publishCatalogue = adminOperation(
    PublishInput,
    async (admin): Promise<PublishResult> =>
      run(admin, false, ({ token, written, publishedAt }): PublishResult => {
        log.info(
          {
            businessEvent: 'catalogue.published',
            requestId: admin.requestId,
            files: written.files,
            bytes: written.bytes,
            items: written.items,
            photos: written.photos,
            publishedAt,
          },
          'Published the catalogue.',
        );
        return { status: 'published', url: url(token), publishedAt };
      }),
  );

  const rotate = adminOperation(
    RotateInput,
    async (admin): Promise<RotateResult> =>
      run(admin, true, ({ token, written, publishedAt, rotated }): RotateResult => {
        const oldRemoved = rotated?.removed ?? false;
        const event = {
          businessEvent: 'catalogue.token.rotated',
          requestId: admin.requestId,
          files: written.files,
          items: written.items,
          photos: written.photos,
          oldRemoved,
          publishedAt,
        };
        if (oldRemoved) log.info(event, 'Rotated the catalogue token; the old link no longer works.');
        else log.warn(event, 'Rotated the catalogue token, but the old link’s files were not all removed or invalidated.');
        return { status: 'rotated', url: url(token), publishedAt, oldRemoved };
      }),
  );

  const republish = adminOperation(
    RepublishInput,
    async (admin): Promise<RepublishResult> => {
      const outcome = await run(
        admin,
        false,
        ({ written, publishedAt }): RepublishResult => {
          log.info(
            {
              businessEvent: 'catalogue.published',
              requestId: admin.requestId,
              republish: true,
              files: written.files,
              bytes: written.bytes,
              items: written.items,
              photos: written.photos,
              publishedAt,
            },
            'Republished the catalogue after a delete.',
          );
          return { catalogue: 'updated' };
        },
        (): RepublishResult => ({ catalogue: 'not-published' }),
      );
      return 'catalogue' in outcome ? outcome : { catalogue: 'stale', requestId: outcome.requestId };
    },
  );

  /**
   * After a delete the owner made of a photo, a set or a parts overview photo (#187): republishes
   * the catalogue, when one is published, so what was deleted leaves the public site within
   * seconds, its photo copies included ([PUB-13], [PUB-16]). It never throws for a failed
   * publish: it answers `stale`, and the delete it follows stands.
   */
  const republishCatalogue = (admin: AdminContext, input: z.input<typeof RepublishInput> = {}): Promise<RepublishResult> => republish(admin, input);

  /** The Rotate button's call: `rotateCatalogueToken(admin)`, its input optional since it takes no option. */
  const rotateCatalogueToken = (admin: AdminContext, input: z.input<typeof RotateInput> = {}): Promise<RotateResult> => rotate(admin, input);

  return { publishCatalogue, rotateCatalogueToken, republishCatalogue };
}

/** Builds `publishCatalogue` alone over its stores. */
export function createPublishCatalogue(dependencies: PublishDependencies) {
  return createPublishStep(dependencies).publishCatalogue;
}

/** Whether the previous snapshot is still the one in the bucket after a failure at `stage`. */
async function keptPrevious(stage: Stage, error: unknown, written: WrittenSnapshot | undefined): Promise<boolean> {
  if (stage === 'read') return true;
  if (stage === 'write') return error instanceof SnapshotWriteError && error.restored;
  // 'invalidate' and 'token': the files were written, but the distribution may keep serving them
  // stale, or the token was not stored, so nothing links to them: put the old ones back, so the
  // bucket, the token and the distribution agree on the previous snapshot.
  try {
    await written?.restore();
    return true;
  } catch {
    return false;
  }
}

/**
 * The error's name, code and message, and its cause's, with the token taken out: the one this
 * publish uses, and anything else of a token's shape, such as a token a failed query was storing
 * (#65). A query's text and parameters are never logged.
 */
function describe(error: unknown, tokens: readonly string[]): Record<string, unknown> {
  const scrub = (text: string) =>
    tokens
      .reduce((scrubbed, token) => scrubbed.split(token).join('[token]'), text)
      .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '[token]');
  const one = (value: unknown) => {
    // Drizzle's query error, by its shape: this module reaches the database only through the
    // projection ([PUB-5]), so it does not import Drizzle to recognise it.
    if (value instanceof Error && 'query' in value && 'params' in value) return { name: value.name, message: 'A database query failed.' };
    return value instanceof Error
      ? { name: value.name, message: scrub(value.message), ...('Code' in value ? { code: String(value.Code) } : {}) }
      : { message: scrub(String(value)) };
  };
  const cause = error instanceof Error && error.cause !== undefined ? { cause: one(error.cause) } : {};
  return { ...one(error), ...cause };
}

/** The publish step as deployed: the Data API, the snapshot and photo buckets and the public distribution. */
let deployedStore: SnapshotStore | undefined;
let deployedInvalidate: ((paths: readonly string[]) => Promise<void>) | undefined;

export const { publishCatalogue, rotateCatalogueToken, republishCatalogue } = createPublishStep({
  database,
  store: () => (deployedStore ??= s3SnapshotStore(snapshotResource().bucket, photosBucket)),
  invalidate: (paths) => (deployedInvalidate ??= cloudFrontInvalidator(snapshotResource().distributionId))(paths),
  publicUrl: () => snapshotResource().url,
});
