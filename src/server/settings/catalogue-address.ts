/**
 * The catalogue's current address, `{public distribution}/c/{token}/`, for the settings page
 * (#163, [PUB-15]): a capability only the admin sees, never content of the catalogue ([PUB-4]).
 * Null before the first publish makes the token.
 *
 * It lives beside `./catalogue-texts.ts`, outside `src/server/publish/`, because only the public
 * projection may reach the database from there ([PUB-5]).
 */
import { catalogueSettings } from '../../db/schema/catalogue-settings';
import { assertAdmin, type AdminContext } from '../auth/admin-context';
import { snapshotResource } from '../publish/aws';
import { snapshotPath } from '../publish/snapshot';
import { isCatalogueToken } from '../publish/token';
import { db } from '../transaction';

/** The address, or null when no token is made yet. `origin` is the public distribution's, deployed by default. */
export async function readCatalogueAddress(admin: AdminContext, origin: () => string = () => snapshotResource().url): Promise<string | null> {
  assertAdmin(admin);
  const [row] = await db().select({ publicToken: catalogueSettings.publicToken }).from(catalogueSettings);
  const token = row?.publicToken ?? null;
  return isCatalogueToken(token) ? `${origin().replace(/\/+$/, '')}${snapshotPath(token)}` : null;
}
