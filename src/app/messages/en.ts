/**
 * Every text the admin shows, in one place (`HANDOVER.md` §10.9, `docs/design/ui.md`): the pages,
 * the components, the dialogs and the queue's states. A component names a message here and holds
 * no text of its own; `tests/app/messages.test.ts` fails on visible text written into a component.
 *
 * It imports nothing, so the server, the device's bundle and the data-free shell all take it.
 */
import type { Condition } from '../_offline/items';

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const en = {
  app: {
    name: 'Plinthos',
    wordmark: 'Plinthos',
  },
  status: {
    label: 'Sync status',
    checking: 'Checking…',
    online: 'Online',
    offline: 'Offline',
    toSync: (count: number) => `${count} to sync`,
    needsYou: (count: number) => `${count} needs you`,
  },
  queue: {
    label: 'Offline queue',
    heldTitle: 'Needs you',
    empty: 'No changes are waiting to sync.',
    waiting: (count: number) => `${count} ${count === 1 ? 'change is' : 'changes are'} waiting to sync.`,
    state: {
      loading: 'Checking the queue on this device…',
      synced: 'Every change on this device is synced.',
      held: 'A change was not applied. Retry it or discard it before the rest can sync.',
      retrying: 'A change failed on the server. It is tried again, a few times, the next times the admin opens or the network returns.',
      'signed-out': 'Your session has ended. Sign in, and the queue syncs.',
      offline: 'No network: changes stay queued on this device and sync when it returns.',
      error: 'The queue could not sync just now. It will try again when the admin is opened.',
    },
    queuedAt: (at: string) => `queued ${at}`,
    held: {
      versionConflict: 'It conflicts: the record changed on the server since.',
      payloadConflict: 'It conflicts with a change already applied under the same id.',
      invalid: (issues: readonly string[]) => `The server refused it as invalid${issues.length > 0 ? `: ${issues.join('; ')}` : '.'}`,
      unknownSet: 'Set number not found. Discard it and its photos, then enter the set again with the right number.',
      unknownItem: 'The set is no longer on the server, so its photos could not be ordered.',
      photoNotOnItem: 'A photo is not one of this set’s photos, so the order could not be saved.',
      failed: (requestId: string) => `It failed on the server${requestId === '' ? '.' : ` (request ${requestId}).`}`,
    },
    mutation: {
      saveItem: 'Saving a set',
      deleteItem: 'Deleting a set',
      setItemPhotos: 'Ordering photos',
      registerPhoto: 'Adding a photo',
      deletePhoto: 'Deleting a photo',
    } as Record<string, string>,
    retry: 'Retry',
    discard: 'Discard',
    confirmDiscard: 'Discard this change? It will not be synced, and this cannot be undone.',
    /** The confirm for a change of several mutations, such as a set and its photos: all of it goes. */
    confirmDiscardGroup: (subject: string | null, photos: number, others: number) => {
      const extras = [photos > 0 ? plural(photos, 'photo', 'photos') : null, others > 0 ? plural(others, 'other change', 'other changes') : null].filter((part) => part !== null);
      if (subject === null) return `Discard these ${photos + others} changes? None of them will sync.`;
      return `Discard ${subject}${extras.length === 0 ? '' : ` and its ${extras.join(' and ')}`}? None of it will sync.`;
    },
  },
  signOut: {
    button: 'Sign out',
    unsynced: (pending: number) =>
      `${pending === 1 ? '1 change has' : `${pending} changes have`} not been synced yet. Signing out deletes ${pending === 1 ? 'it' : 'them'} from this device. Sign out anyway?`,
    unopened:
      'The queue on this device could not be opened, so it may hold changes that have not been synced yet. Signing out deletes them from this device. Sign out anyway?',
    undeleted:
      'The queue on this device could not be deleted, so you are still signed in. Close any other admin tabs, or reload this page, then sign out again.',
    offline: 'Signing out needs a network, so the server can end the session. Nothing was changed on this device.',
  },
  items: {
    title: 'Plinthos',
    filterLabel: 'Filter by number or name',
    filterPlaceholder: 'Filter by number or name',
    listLabel: 'Items',
    empty: 'No sets yet. Tap Add set to log the first one.',
    noMatch: 'No set matches the filter.',
    notSynced: 'Not synced',
    needsYou: 'Needs you',
    deleting: 'Being deleted',
    addSet: '+ Add set',
    summary: (sets: number, items: number) => `${plural(sets, 'set', 'sets')} · ${plural(items, 'item', 'items')}`,
    meta: (condition: Condition, quantity: number) => `${en.condition[condition]} · ×${quantity}`,
    coverAlt: (setNum: string) => `Cover photo of ${setNum}`,
    noCover: 'No photo',
    footerLabel: 'More',
    photos: 'Photos',
  },
  condition: {
    SEALED: 'Sealed',
    USED_WITH_BOX: 'Used, box',
    USED_NO_BOX: 'Used, no box',
  } satisfies Record<Condition, string>,
  form: {
    back: '← Items',
    addTitle: 'Add set',
    editTitle: 'Edit set',
    offlineTitle: 'Add set offline',
    search: {
      label: 'Set',
      placeholder: 'Number or name, such as 10294 or Titanic',
      searching: 'Searching…',
      noResults: 'No set matches. Check the number, or type it below.',
      resultsLabel: 'Matching sets',
      unavailable: 'Set search is unavailable just now. Type the set number instead.',
      typedLabel: 'Set number',
      typedPlaceholder: '10294-1',
      typedHint: 'Saved now, details filled in when it syncs',
      useTyped: 'Type the set number instead',
      useSearch: 'Search instead',
      change: 'Change',
      chosen: 'Chosen',
    },
    setMeta: (set: { theme: string | null; year: number | null; numParts: number | null }) =>
      [set.theme, set.year === null ? null : String(set.year), set.numParts === null ? null : `${set.numParts.toLocaleString('en')} pcs`].filter((part) => part !== null).join(' · '),
    setImageAlt: (name: string) => `Box of ${name}`,
    photos: {
      label: 'Photos',
      add: 'Add photo',
      cover: '★',
      coverLabel: 'Cover',
      photoLabel: (position: number, cover: boolean) => `Photo ${position}${cover ? ', the cover' : ''}`,
      sheetLabel: 'Photo actions',
      makeCover: 'Make cover',
      moveLeft: 'Move left',
      moveRight: 'Move right',
      remove: 'Remove',
      close: 'Close',
      unreadable: 'The photo could not be read on this device. Try another one.',
      noQueue: 'This browser keeps no offline queue, so photos cannot be added here.',
    },
    conditionLabel: 'Condition',
    complete: 'Complete',
    missing: "What's missing",
    instructions: 'Instructions',
    yes: 'Yes',
    no: 'No',
    quantity: 'Quantity',
    decrease: 'One fewer',
    increase: 'One more',
    description: 'Description',
    storage: 'Storage',
    storageIcon: '🔒',
    storageHint: 'Private, never published',
    saveAndNext: 'Save & add next',
    save: 'Save',
    saving: 'Saving…',
    delete: 'Delete set',
    confirmDelete: 'Delete this set and its photos? This cannot be undone once it syncs.',
    editOffline: 'Editing a set needs the network. Your change is kept on this device and syncs when it returns.',
    problems: {
      required: 'Fill this in.',
      setNumber: 'A set number is letters and digits, up to 40, such as 10294 or 10294-1.',
      quantity: 'A quantity from 1 to 999.',
      tooLong: 'This is too long.',
    },
    problemSummary: 'Check the fields marked below.',
    queueFailed: 'This set could not be kept on this device. Nothing was lost from the form: try again.',
    toast: (setNum: string, photos: number) => `Saved ${setNum} · ${plural(photos, 'photo', 'photos')}`,
  },
  photosPage: {
    title: 'Photos',
    capture: 'Add photos',
    captureQueued: (count: number) => `${count} ${count === 1 ? 'photo is' : 'photos are'} queued on this device.`,
    stored: 'Stored photos',
    empty: 'No photos are stored yet. A photo you add appears here once it has synced.',
    alt: (createdAt: string) => `Photo added ${createdAt}`,
    delete: 'Delete',
  },
  publish: {
    button: 'Publish',
    pending: 'Publishing…',
    published: (at: string) => `Published at ${at}:`,
    failed: 'Publishing failed.',
    busy: 'Another publish is still running: wait for it to finish, then publish again.',
    kept: 'The previous catalogue is still online, unchanged.',
    partial: 'The catalogue may be partly updated: publish again.',
    reference: (requestId: string) => `Reference: ${requestId}`,
  },
  offline: {
    title: 'Plinthos',
    intro: "This is the admin's offline shell. Sets you add here wait on this device until there is a network.",
    queuedTitle: 'On this device',
    openAdmin: 'Open the admin',
  },
  login: {
    title: 'Sign in',
    username: 'Username',
    password: 'Password',
    submit: 'Sign in',
    failed: 'Wrong username or password',
  },
  failure: {
    title: 'Something went wrong',
    browser: 'This failed in the browser, before the server answered, so the server logged nothing.',
    serverBefore: 'The server could not finish this request. Its request id is',
    serverAfter: ": search the admin's log group for it.",
  },
} as const;

export type Messages = typeof en;
