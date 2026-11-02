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
  // A photo is never published yet (#22): every column is private until the public catalogue
  // milestone decides what a buyer may see of one.
  photo: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    full_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    thumbnail_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    sha256: { visibility: 'private', reason: 'a hash of the uploaded bytes, which can confirm a guess at the original photo' },
    created_at: { visibility: 'private', reason: 'when the owner took or added the photo, which is no buyer’s business' },
    item_id: { visibility: 'private', reason: 'an internal key, which nothing public needs (ITEM-6)' },
    position: { visibility: 'private', reason: 'the photo’s place among its item’s, private with the rest of the photo until the public catalogue milestone (ITEM-6)' },
  },
  // Rebrickable's public catalogue data, cached (CAT-3): what any visitor of Rebrickable sees.
  lego_set: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    set_num: { visibility: 'public', reason: 'the set’s catalogue number, Rebrickable’s public data (CAT-3)' },
    name: { visibility: 'public', reason: 'the set’s catalogue name, Rebrickable’s public data (CAT-3)' },
    theme: { visibility: 'public', reason: 'the set’s theme, Rebrickable’s public data (CAT-3)' },
    year: { visibility: 'public', reason: 'the set’s release year, Rebrickable’s public data (CAT-3)' },
    num_parts: { visibility: 'public', reason: 'the set’s piece count, Rebrickable’s public data (CAT-3)' },
    image_url: { visibility: 'public', reason: 'the set’s stock image on Rebrickable’s CDN, its public data (CAT-3)' },
    fetched_at: { visibility: 'private', reason: 'when the admin looked the set up: the cache’s state and the admin’s activity' },
  },
  // No item is published yet: the public catalogue milestone publishes items. The columns marked
  // public are the ones HANDOVER.md §4.3's set page shows a visitor.
  collection_item: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    set_num: { visibility: 'public', reason: 'which set the item is, shown on the catalogue’s set page (HANDOVER.md §4.3)' },
    condition: { visibility: 'public', reason: 'the item’s condition, shown on the catalogue’s set page (HANDOVER.md §4.3)' },
    complete: { visibility: 'public', reason: 'whether the item is complete, shown on the catalogue’s set page (HANDOVER.md §4.3)' },
    missing_note: { visibility: 'public', reason: 'what an incomplete item is missing: its completeness, shown on the set page (HANDOVER.md §4.3)' },
    has_instructions: { visibility: 'public', reason: 'whether the instructions are there: part of its completeness, shown on the set page' },
    description: { visibility: 'public', reason: 'the owner’s description for visitors, shown on the set page (HANDOVER.md §4.3)' },
    quantity: { visibility: 'public', reason: 'how many of the set the collection holds, which the catalogue counts' },
    storage_location: { visibility: 'private', reason: 'where the owner keeps the set: private by AGENTS.md §1 and ITEM-1' },
    cover_photo_id: { visibility: 'private', reason: 'an internal key of a photo, private with the photo (ITEM-6)' },
    version: { visibility: 'private', reason: 'the record’s version for the sync conflict rule: internal state (ITEM-3)' },
    created_at: { visibility: 'private', reason: 'when the owner logged the item, which is no buyer’s business' },
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
