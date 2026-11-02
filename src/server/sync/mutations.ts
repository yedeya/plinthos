/**
 * The production registry: every mutation the deployed offline-sync endpoint replays ([SYNC-1]).
 * The walking skeleton's are the photo upload's `registerPhoto` and `deletePhoto` (#22, brief #6,
 * decision 19), both in `../photos/`. Set entry adds the items' `saveItem`, `deleteItem` and
 * `setItemPhotos` (#124), in `../items/`.
 */
import { ITEM_MUTATIONS } from '../items/items';
import { PHOTO_MUTATIONS } from '../photos/photos';
import { syncRegistry, type SyncRegistry } from './registry';

export const MUTATIONS: SyncRegistry = syncRegistry([...PHOTO_MUTATIONS, ...ITEM_MUTATIONS]);
