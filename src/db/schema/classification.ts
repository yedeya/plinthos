/**
 * Every column of the database, classified public or private: the one registry `[PUB-3]` names.
 *
 * - **public**: the publish step's projection may write its value into the snapshot
 *   (`src/server/publish/projection.ts`).
 * - **private**: its value never leaves the private side, in any snapshot, under any setting
 *   (`[PUB-4]`). Storage locations, purchase prices and internal notes are private (`AGENTS.md`
 *   §1), and so is every value and asking price: whether buyers see those is the settings'
 *   decision, which the publish step's projection applies, never a column's classification.
 *
 * A column missing here fails `tests/db/classification.test.ts`, and so does an entry for a
 * column that doesn't exist. When in doubt, classify a column private: making it public later is
 * a decision the Owner reviews, and leaking it is not reversible.
 */

export type Visibility = 'public' | 'private';

export interface Classification {
  readonly visibility: Visibility;
  /** Why, in a phrase, so a reviewer can check it against `AGENTS.md` §1. */
  readonly reason: string;
}

/** Table name → column name → classification, by the names the database uses. */
export const CLASSIFICATION: Readonly<Record<string, Readonly<Record<string, Classification>>>> = {
  admin_session: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    id_hash: { visibility: 'private', reason: 'the hash of a credential: it identifies a signed-in session' },
    created_at: { visibility: 'private', reason: 'when the admin signed in, which is no buyer’s business' },
    last_seen_at: { visibility: 'private', reason: 'when the admin was last active, which is no buyer’s business' },
    key_fingerprint: { visibility: 'private', reason: 'derived from the cookie key, a credential: it names which key signed a session' },
  },
  applied_mutation: {
    id: { visibility: 'private', reason: 'the client’s id for an offline mutation, which nothing public needs' },
    name: { visibility: 'private', reason: 'which service function the admin ran: the admin’s own activity' },
    payload_hash: { visibility: 'private', reason: 'a hash of what the admin sent, which can confirm a guess at private input' },
    result: { visibility: 'private', reason: 'what a service function returned, which can carry private fields' },
    applied_at: { visibility: 'private', reason: 'when the admin’s change was applied, which is no buyer’s business' },
  },
  // A photo is never published in the walking skeleton (#22): every column is private until the
  // public catalogue milestone decides what a buyer may see of one.
  photo: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    full_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    thumbnail_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    sha256: { visibility: 'private', reason: 'a hash of the uploaded bytes, which can confirm a guess at the original photo' },
    created_at: { visibility: 'private', reason: 'when the owner took or added the photo, which is no buyer’s business' },
  },
  catalogue_settings: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    public_token: {
      visibility: 'private',
      reason: 'the capability that addresses the snapshot: it is the path, never content inside it',
    },
    // #19 decided that the snapshot needs none of the three: the projection applies them, so the
    // snapshot shows their effect, which values appear, and never the switch itself.
    show_values: { visibility: 'private', reason: 'a setting the projection applies, not catalogue content (#19)' },
    selling_mode: { visibility: 'private', reason: 'a setting the projection applies, not catalogue content (#19)' },
    selling_value_display: { visibility: 'private', reason: 'a setting the projection applies, not catalogue content (#19)' },
  },
};
