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
  // Every column of a photo stays private (#154): a published photo is a copy of its stored sizes
  // under a new random key in the snapshot (PUB-13), so no key, hash or position here is ever
  // content. The projection reads the keys to copy from and the order, and publishes neither.
  photo: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    full_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    thumbnail_key: { visibility: 'private', reason: 'the key of a private object: it is a capability, never content (PHOTO-6)' },
    sha256: { visibility: 'private', reason: 'a hash of the uploaded bytes, which can confirm a guess at the original photo' },
    created_at: { visibility: 'private', reason: 'when the owner took or added the photo, which is no buyer’s business' },
    item_id: { visibility: 'private', reason: 'an internal key linking the photo to its item, which nothing public needs' },
    position: { visibility: 'private', reason: 'the photo’s place in the admin’s order: internal until the public catalogue decides (#124)' },
    parts_lot: { visibility: 'private', reason: 'whether the photo is one of the parts lot’s: internal, the publish step decides what it shows (PARTS-5)' },
  },
  // The last parts import (#161, PARTS-3, PARTS-4). The catalogue may show the parts summary, how
  // many lots and parts there are; the value never is, whatever the settings say (PUB-4).
  parts_import: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    file_format: { visibility: 'private', reason: 'which program the owner keeps the parts in: no buyer’s business' },
    currency: { visibility: 'private', reason: 'the currency of the file’s private prices, which only those prices need' },
    imported_at: { visibility: 'private', reason: 'when the owner imported the file: the admin’s own activity' },
    lots: { visibility: 'public', reason: 'how many lots the loose parts are, the parts summary a visitor reads (HANDOVER §4.2)' },
    quantity: { visibility: 'public', reason: 'how many loose parts there are, the parts summary a visitor reads (HANDOVER §4.2)' },
    total_value: { visibility: 'private', reason: 'the value of the loose parts: private by rule, like every value (AGENTS.md §1, PARTS-4)' },
  },
  // A lot's identity and count are public since #211: selling mode's parts download lists them
  // (PUB-20, #5), and the projection publishes them only there, only in selling mode. Its unit
  // price stays private, like every value: only the settings decide whether a buyer sees it.
  parts_lot: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    import_id: { visibility: 'private', reason: 'an internal key linking the lot to its import' },
    item_type: { visibility: 'public', reason: 'what the lot is (part, minifigure), a line of the parts download in selling mode (PUB-20)' },
    item_no: { visibility: 'public', reason: 'BrickLink’s number for the lot’s item, a line of the parts download in selling mode (PUB-20)' },
    color_id: { visibility: 'public', reason: 'BrickLink’s colour of the lot, a line of the parts download in selling mode (PUB-20)' },
    lot_condition: { visibility: 'public', reason: 'whether the lot is new or used, a line of the parts download in selling mode (PUB-20)' },
    lot_quantity: { visibility: 'public', reason: 'how many parts the lot holds, a line of the parts download in selling mode (PUB-20)' },
    unit_price: { visibility: 'private', reason: 'a price: private by rule, like every value; the settings decide whether it is shown (AGENTS.md §1, PARTS-4, PUB-20)' },
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
    // The public catalogue names each item's page by it, `/c/{token}/s/{id}/` (#154, PUB-12): a
    // random UUID the phone made, which says nothing about the item and opens nothing private.
    id: { visibility: 'public', reason: 'the item’s random key, which names its page in the public catalogue (PUB-12)' },
    kind: { visibility: 'public', reason: 'whether the item is a set, a minifigure, a bulk lot or another item, which the catalogue filters by (#202)' },
    set_num: { visibility: 'public', reason: 'which set the item is, the catalogue’s first fact about it' },
    name: { visibility: 'public', reason: 'a non-set item’s own name, which the catalogue shows as a set’s (#202)' },
    ref_no: { visibility: 'public', reason: 'the item’s figure or BrickLink number, a public fact about what it is (#202)' },
    approx_parts: { visibility: 'public', reason: 'a bulk lot’s approximate piece count, which a visitor reads (#202)' },
    approx_weight_g: { visibility: 'public', reason: 'a bulk lot’s approximate weight, which a visitor reads (#202)' },
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
    manual_value_override: { visibility: 'private', reason: 'the owner’s own value of the item: private by rule, like every value (AGENTS.md §1, VAL-5)' },
    manual_value_currency: { visibility: 'private', reason: 'the currency of a private value, which only that value needs (VAL-5)' },
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
    intro_text: { visibility: 'public', reason: 'the catalogue’s intro, which the owner writes for visitors (PUB-9)' },
    contact_text: { visibility: 'public', reason: 'how a visitor reaches the owner, which the owner writes for visitors (PUB-9)' },
    // The asking prices (#211): private like every price. The projection shows them only in
    // selling mode, with `selling_value_display` ASKING or BOTH (PUB-18), never by classification.
    asking_price_total: { visibility: 'private', reason: 'an asking price: private by rule; the settings decide whether buyers see it (AGENTS.md §1, PUB-18)' },
    asking_price_sealed: { visibility: 'private', reason: 'an asking price: private by rule; the settings decide whether buyers see it (AGENTS.md §1, PUB-18)' },
    asking_price_used: { visibility: 'private', reason: 'an asking price: private by rule; the settings decide whether buyers see it (AGENTS.md §1, PUB-18)' },
    asking_price_parts: { visibility: 'private', reason: 'an asking price: private by rule; the settings decide whether buyers see it (AGENTS.md §1, PUB-18)' },
    adjust_used_with_box_pct: { visibility: 'private', reason: 'how the owner adjusts a used set’s market price: it would reveal the values (VAL-5)' },
    adjust_used_no_box_pct: { visibility: 'private', reason: 'how the owner adjusts a used set’s market price: it would reveal the values (VAL-5)' },
  },
  // The market prices BrickLink answered (#207, VAL-2): every column is private, because a price
  // is a value, which only the settings may show, through the projection (PUB-17).
  price_quote: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    item_type: { visibility: 'private', reason: 'which kind of item a private price is for, which only the price needs' },
    item_no: { visibility: 'private', reason: 'which item a private price is for: it ties the price to an item' },
    new_or_used: { visibility: 'private', reason: 'which condition a private price is for, which only the price needs' },
    average: { visibility: 'private', reason: 'a market price: private by rule, like every value (AGENTS.md §1, VAL-2)' },
    sample_size: { visibility: 'private', reason: 'how many sales a private price averages: part of the price' },
    currency: { visibility: 'private', reason: 'the currency of a private price, which only the price needs' },
    source: { visibility: 'private', reason: 'where a private price came from, which only the price needs' },
    fetched_at: { visibility: 'private', reason: 'when a private price was fetched: the admin’s own activity' },
    attempted_at: { visibility: 'private', reason: 'when the admin last asked for a price: the admin’s own activity' },
    last_error: { visibility: 'private', reason: 'why BrickLink last refused a price: internal state' },
  },
};
