/**
 * The production registry: every mutation the deployed offline-sync endpoint replays ([SYNC-1]).
 * The walking skeleton's are the photo upload's `registerPhoto` and `deletePhoto` (#22, brief #6,
 * decision 19), both in `../photos/`.
 */
import { PHOTO_MUTATIONS } from '../photos/photos';
import { syncRegistry, type SyncRegistry } from './registry';

export const MUTATIONS: SyncRegistry = syncRegistry([...PHOTO_MUTATIONS]);
