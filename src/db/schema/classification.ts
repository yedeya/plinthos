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
  // A photo is not published yet (#22, #124): every column is private until the public
  // catalogue milestone decides what a buyer may see of one.
  photo: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    full_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    thumbnail_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    sha256: { visibility: 'private', reason: 'a hash of the uploaded bytes, which can confirm a guess at the original photo' },
    created_at: { visibility: 'private', reason: 'when the owner took or added the photo, which is no buyer’s business' },
    item_id: { visibility: 'private', reason: 'an internal key linking the photo to its item, which nothing public needs' },
    position: { visibility: 'private', reason: 'the photo’s place in the admin’s order: internal until the public catalogue decides (#124)' },
  },
  // The set catalogue's own data, cached from Rebrickable (#124, CAT-3): public facts about a set.
  lego_set: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    set_num: { visibility: 'public', reason: 'the set’s catalogue number, a public fact about the set' },
    name: { visibility: 'public', reason: 'the set’s catalogue name, a public fact about the set' },
    theme: { visibility: 'public', reason: 'the set’s catalogue theme, a public fact about the set' },
    year: { visibility: 'public', reason: 'the set’s release year, a public fact about the set' },
    num_parts: { visibility: 'public', reason: 'the set’s piece count, a public fact about the set' },
    image_url: { visibility: 'public', reason: 'the catalogue’s own stock image of the set, already public' },
    fetched_at: { visibility: 'private', reason: 'when the admin looked the set up: the admin’s own activity' },
  },
  // An item as the owner entered it (#124, ITEM-1). The fields a buyer is meant to read about the
  // set they would get are public, as `HANDOVER.md` §4.1 lists them; the storage location never is.
  collection_item: {
    id: { visibility: 'private', reason: 'the client’s key for the item: the public catalogue milestone decides its public address' },
    set_num: { visibility: 'public', reason: 'which set the item is, the catalogue’s first fact about it' },
    condition: { visibility: 'public', reason: 'the item’s condition, which a visitor reads (HANDOVER §4.1)' },
    complete: { visibility: 'public', reason: 'whether the item is complete, which a visitor reads (HANDOVER §4.1)' },
    missing_notes: { visibility: 'public', reason: 'what the item is missing, which a visitor reads (HANDOVER §4.1)' },
    has_instructions: { visibility: 'public', reason: 'whether the item has its instructions, which a visitor reads (HANDOVER §4.1)' },
    description: { visibility: 'public', reason: 'the item’s description for visitors: box damage, fading, stickers (HANDOVER §4.1)' },
    quantity: { visibility: 'public', reason: 'how many of the set the owner holds, which a visitor reads (HANDOVER §4.1)' },
    storage_location: { visibility: 'private', reason: 'where the owner keeps the item: private by rule, never shown (AGENTS.md §1, ITEM-1)' },
    cover_photo_id: { visibility: 'private', reason: 'an internal key of a private photo, which nothing public needs' },
    version: { visibility: 'private', reason: 'the record’s version for offline sync: internal state (SYNC-3)' },
    created_at: { visibility: 'private', reason: 'when the owner entered the item, which is no buyer’s business' },
    updated_at: { visibility: 'private', reason: 'when the owner last changed the item, which is no buyer’s business' },
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
    publish_lease: { visibility: 'private', reason: 'which publish holds the turn to write the snapshot: internal state (#68)' },
    publish_lease_until: { visibility: 'private', reason: 'when that turn runs out: internal state, which is no buyer’s business (#68)' },
  },
};
