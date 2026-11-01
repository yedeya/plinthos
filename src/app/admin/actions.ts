'use server';

/**
 * The admin's Server Actions. Each is wrapped in `adminAction`, so a call without the signed-in
 * admin's session, or from another origin, is refused before it runs ([AUTH-3], [AUTH-5]).
 */
import { adminAction } from '../../server/auth/admin';
import { publishCatalogue, type PublishResult } from '../../server/publish/publish';

/** The Publish button: publishes the catalogue and answers with the outcome the form shows ([OPS-6]). */
export const publish = adminAction(async (admin): Promise<PublishResult> => publishCatalogue(admin, {}), { name: 'publish' });
