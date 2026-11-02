/**
 * The production registry: every mutation the deployed offline-sync endpoint replays ([SYNC-1]).
 * The photo upload's `registerPhoto` and `deletePhoto` (#22, brief #6, decision 19), in
 * `../photos/`, and the items' `saveItem`, `deleteItem` and `setItemPhotos` (#133, [ITEM-2]), in
 * `../items/`.
 */
import { ITEM_MUTATIONS } from '../items/items';
import { PHOTO_MUTATIONS } from '../photos/photos';
import { syncRegistry, type SyncRegistry } from './registry';

export const MUTATIONS: SyncRegistry = syncRegistry([...PHOTO_MUTATIONS, ...ITEM_MUTATIONS]);
