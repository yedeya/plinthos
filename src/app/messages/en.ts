/**
 * Every text the admin shows, in one place (`HANDOVER.md` §10.9, `docs/design/ui.md`): the pages,
 * the components, the dialogs and the queue's states. A component names a message here and holds
 * no text of its own; `tests/app/messages.test.ts` fails on visible text written into a component.
 *
 * It imports nothing, so the server, the device's bundle and the data-free shell all take it.
 */
import type { Condition, ItemKind } from '../_offline/items';

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** An amount in its currency, such as `€1,234.50`; a code `Intl` can't format is written after the number. */
const money = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/** A unit price in its currency, with up to three decimals, as a parts file and BrickLink give them. */
const unitMoney = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(amount);
  } catch {
    return `${amount.toFixed(3)} ${currency}`;
  }
};

/** A quote's date, such as `3 Nov 2026`, in UTC so the server and the browser write the same. */
const day = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const en = {
  app: {
    name: 'Plinthos',
    wordmark: 'Plinthos',
  },
  /** The admin's loading screen (`src/app/admin/loading.tsx`, #203), shown while a page waits for the server. */
  loading: {
    title: 'Loading…',
    hint: 'Waking the database. After a quiet spell this can take up to half a minute.',
  },
  status: {
    label: 'Sync status',
    checking: 'Checking…',
    online: 'Online',
    offline: 'Offline',
    toSync: (count: number) => `${count} to sync`,
    uploading: (uploaded: number, total: number) => `Uploading ${uploaded}/${total}`,
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
      abandoned: 'The page changed before the sync answered. The admin syncs the queue again when it opens.',
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
    /** Distinct sets, other items (minifigures, bulk lots and the rest, #202) when there are any, and every item counted by its quantity. */
    summary: (sets: number, others: number, items: number) =>
      [plural(sets, 'set', 'sets'), others === 0 ? null : `${others} other`, plural(items, 'item', 'items')].filter((part) => part !== null).join(' · '),
    /** The small label a non-set carries in the list (#202); a set carries none. */
    kind: {
      SET: 'Set',
      MINIFIG: 'Minifigure',
      BULK: 'Bulk lot',
      OTHER: 'Other',
    } satisfies Record<ItemKind, string>,
    meta: (condition: Condition, quantity: number) => `${en.condition[condition]} · ×${quantity}`,
    coverAlt: (label: string) => `Cover photo of ${label}`,
    stockAlt: (label: string) => `Catalogue image of ${label}`,
    noCover: 'No photo',
    footerLabel: 'More',
    photos: 'Photos',
    parts: 'Parts',
    settings: 'Settings',
    /** The export's downloads and the printable catalogue (#236, #255, [EXP-1], [EXP-5]). */
    exportBuyer: 'CSV for a buyer',
    exportFull: 'Full CSV (holds private fields)',
    summaryLink: 'Printable catalogue',
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
      label: 'Set number or name',
      placeholder: 'Set number or name, such as 10294 or Titanic',
      searching: 'Searching…',
      noResults: 'No set matches.',
      resultsLabel: 'Matching sets',
      unavailable: "Search isn't answering right now; you can still save by set number",
      partial: "Search isn't answering right now; these are sets already saved here. You can still save by set number",
      willSave: (setNum: string) => `Will save as ${setNum}`,
      willResolve: (setNum: string) => `Will save as ${setNum}; details are filled in when it syncs`,
      change: 'Change',
      chosen: 'Chosen',
      notASet: 'Not a set?',
    },
    /** The non-set half of the form (#202): what it is, its name and reference number, and a bulk lot's two numbers. */
    kind: {
      label: 'What is it?',
      logAs: 'Not a set? Log it as',
      MINIFIG: 'Minifigure',
      BULK: 'Bulk lot',
      OTHER: 'Other',
      backToSet: 'It’s a set',
    } satisfies Record<Exclude<ItemKind, 'SET'>, string> & Record<string, string>,
    name: 'Name',
    namePlaceholder: 'Such as Pirate captain or Mixed Technic',
    refNo: 'Reference number',
    refNoHint: 'Optional: a figure number such as sw0001, or a BrickLink item number',
    approxParts: 'Approximate pieces',
    approxWeight: 'Approximate weight (g)',
    notStated: 'Not stated',
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
      preparing: 'Preparing…',
      preparingLabel: 'A photo being prepared',
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
    /** While Save waits for its sync's photo uploads (#203). */
    uploadingPhotos: (uploaded: number, total: number) => `Uploading photos ${uploaded} of ${total}`,
    saveProgressLabel: 'Saving progress',
    preparingPhotos: 'Preparing photos…',
    delete: 'Delete set',
    confirmDelete: 'Delete this set and its photos? This cannot be undone once it syncs. If the catalogue is published, it is republished without them.',
    editOffline: 'Editing a set needs the network. Your change is kept on this device and syncs when it returns.',
    problems: {
      required: 'Fill this in.',
      setNumber: 'A set number is letters and digits, up to 40, such as 10294 or 10294-1.',
      pickSet: 'Pick a set from the results, or type its set number, such as 10294.',
      quantity: 'A quantity from 1 to 999.',
      tooLong: 'This is too long.',
      pieces: 'A piece count from 1 to 1,000,000, or leave it empty.',
      weight: 'A weight in grams from 1 to 10,000,000, or leave it empty.',
    },
    problemSummary: 'Check the fields marked below.',
    queueFailed: 'This set could not be kept on this device. Nothing was lost from the form: try again.',
    toast: (label: string, photos: number) => `Saved ${label} · ${plural(photos, 'photo', 'photos')}`,
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
  parts: {
    title: 'Parts',
    summaryLabel: 'Last import',
    none: 'No parts are imported yet. Export your parts from BrickStore (.bsx) or BrickLink (XML) and import the file here.',
    lots: (count: number) => plural(count, 'lot', 'lots'),
    quantity: (count: number) => `${count.toLocaleString('en')} ${count === 1 ? 'part' : 'parts'}`,
    value: (total: number, currency: string | null) =>
      `Total value ${total.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency === null ? '' : ` ${currency}`} (from the file’s prices; private)`,
    noValue: 'The file had no prices.',
    importedAt: (at: string) => `Imported ${new Date(at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}`,
    format: (format: 'BSX' | 'BL_XML') => (format === 'BSX' ? 'BrickStore file' : 'BrickLink XML'),
    importLabel: 'Import a parts file',
    choose: 'Import a .bsx or XML file',
    replaceWarning: 'Importing a file replaces the whole parts inventory above. It is not merged.',
    confirmReplace: (lots: number) => `Replace the current ${plural(lots, 'lot', 'lots')} with this file? The current inventory is not kept.`,
    needsNetwork: 'Importing a file needs the network: try again when you are online.',
    uploading: 'Uploading the file…',
    importing: 'Importing…',
    imported: (lots: number, quantity: number) => `Imported ${plural(lots, 'lot', 'lots')}, ${quantity.toLocaleString('en')} ${quantity === 1 ? 'part' : 'parts'}.`,
    skipped: (places: readonly number[], count: number = places.length) =>
      `Skipped ${plural(count, 'lot', 'lots')} with no item number (${count === 1 ? 'lot' : 'lots'} ${places.slice(0, 10).join(', ')}${count > Math.min(places.length, 10) ? ', …' : ''}). Fix or delete ${count === 1 ? 'it' : 'them'} in BrickStore and import again to include ${count === 1 ? 'it' : 'them'}.`,
    tooLarge: (maxBytes: number) => `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB, the limit this deployment takes.`,
    refused: (reason: string, lot?: { readonly index: number; readonly itemNo?: string }) =>
      `The file was not imported, and nothing changed: ${lot === undefined ? '' : `lot ${lot.index}${lot.itemNo === undefined ? '' : ` (${lot.itemNo})`}: `}${reason}.`,
    failed: 'The import failed, and nothing changed. Try again.',
    signedOut: 'Your session has ended: sign in again, then import the file.',
    photosLabel: 'Overview photos',
    photosHint: (max: number) => `Up to ${max} photos of the parts lot as a whole. They queue on this device and sync like any photo.`,
    photosFull: (max: number) => `The parts lot has its ${max} photos. Delete one to add another.`,
    photosEmpty: 'No overview photos yet. A photo you add appears here once it has synced.',
    photoAlt: (position: number) => `Parts overview photo ${position}`,
    addPhotos: 'Add photos',
    deletePhoto: 'Delete',
    /** The loose parts' value by source and the lots, 100 to a page ([VAL-6], [VAL-11], #229). */
    valueLabel: 'Value of the parts',
    valueHint: 'A lot is valued at its BrickLink price when BrickLink has one, otherwise at the file’s price when the file is in your currency. Only you see these values.',
    valueTotal: (amount: number | null, currency: string) => (amount === null ? 'No lot has a value yet.' : `${money(amount, currency)} in all`),
    bySource: (fromBrickLink: number, fromFile: number, none: number) =>
      `${plural(fromBrickLink, 'lot', 'lots')} from BrickLink · ${plural(fromFile, 'lot', 'lots')} from the file’s prices · ${plural(none, 'lot', 'lots')} without a value`,
    lotsLabel: 'Lots',
    lotsEmpty: 'The import has no lots.',
    column: { type: 'Type', number: 'Item', color: 'Colour', condition: 'Condition', quantity: 'Qty', unitPrice: 'Unit price', value: 'Value', source: 'Source' },
    lotCondition: { N: 'New', U: 'Used' },
    unitPrice: unitMoney,
    lotValue: money,
    /** A lot's unit price in the file's own currency, which values nothing because it isn't yours. */
    fileOnly: (amount: number, currency: string) => `${unitMoney(amount, currency)} (file)`,
    noPrice: '—',
    source: {
      bricklink: (asOf: string) => `BrickLink, ${day(asOf)}`,
      file: 'File',
      none: 'None',
    },
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    pagesLabel: 'Pages of lots',
    previous: 'Previous',
    next: 'Next',
  },
  /** What the public catalogue came to after a delete (#187, [PUB-16]). */
  catalogueAfterDelete: {
    updated: 'Deleted, and removed from the public catalogue.',
    stale: 'Deleted, but the public catalogue still shows it: press Publish on the home page to remove it.',
    deleteHint: 'Deleting a photo also removes it from the public catalogue, if one is published.',
    dismiss: 'Dismiss',
  },
  /** The collection's values on `/admin`, the edit form and `/admin/settings` (#207, [VAL-3] to [VAL-7]): private to the admin. */
  values: {
    money,
    title: 'Values',
    privateHint: 'Only you see these values. The catalogue shows none of them.',
    totalsLabel: 'Values by segment',
    segment: { sealed: 'Sealed', used: 'Used', parts: 'Parts', all: 'Total' },
    noValue: 'No value',
    unvalued: (count: number) => `${count} without a value`,
    /** An item's value with its source and date ([VAL-5]). */
    fromBrickLink: (amount: number, currency: string, asOf: string) => `${money(amount, currency)} · BrickLink, as of ${day(asOf)}`,
    fromOverride: (amount: number, currency: string) => `${money(amount, currency)} · your value`,
    refresh: 'Refresh prices',
    refreshLabel: 'Price refresh',
    refreshHint: 'Asks BrickLink for the prices not fetched in the last 7 days. Every price asks for all of them again.',
    scopeLabel: 'What to refresh',
    scope: { items: 'Sets and minifigures', parts: 'Parts', all: 'Everything' },
    refreshAll: 'Every price',
    refreshStarting: 'Starting the price refresh…',
    refreshStarted: 'The price refresh runs in the background. You may close this page; the new prices show once it is done.',
    refreshBusy: 'A price refresh is already running. Press Refresh prices again once it is done.',
    refreshNotStarted: 'The price refresh could not be started. Try again later; every price you had is kept.',
    refreshFailed: 'The refresh failed on the server. Every price you had is kept.',
    needsNetwork: 'Refreshing prices needs a network.',
    /** The running run's progress and the last run's outcome ([VAL-9] to [VAL-11], #229). */
    runScope: (scope: 'items' | 'parts' | 'all', all: boolean) =>
      `${{ items: 'Sets and minifigures', parts: 'Parts', all: 'Everything' }[scope]}${all ? ', every price' : ''}`,
    running: 'Refreshing prices in the background.',
    progress: (done: number, failed: number, left: number) => `${done.toLocaleString('en')} done · ${failed.toLocaleString('en')} failed · ${left.toLocaleString('en')} left`,
    progressLabel: 'Refresh progress',
    stop: 'Stop',
    stopping: 'Stopping after the current request…',
    stopFailed: 'The refresh could not be stopped. Try again.',
    statusFailed: 'The refresh’s progress could not be read. It goes on in the background.',
    lastRun: (finishedAt: string) => `Last refresh, ended ${day(finishedAt)}:`,
    outcome: {
      done: 'Done. The new prices show when you reload the page.',
      owner: 'Stopped, as you asked. Press Refresh prices to carry on.',
      'refused-key': 'Stopped: BrickLink refused the keys. Check the BrickLink secrets of the deployment; every price you had is kept.',
      'rate-limited': 'Stopped: BrickLink asked to slow down. Try again later; every price you had is kept.',
      unreachable: 'Stopped: BrickLink could not be reached. Try again later; every price you had is kept.',
      'invoke-failed': 'Stopped: the refresh could not start. Try again later; every price you had is kept.',
      'daily-limit': 'Stopped at today’s limit of BrickLink calls. Press Refresh prices again after midnight UTC: it carries on where it stopped, since the prices already fetched are kept for 7 days.',
      stalled: 'Stopped: the refresh stalled, with no sign of life for 20 minutes. Press Refresh prices to carry on.',
    },
    callsToday: (calls: number, limit: number) => `BrickLink calls today (UTC): ${calls.toLocaleString('en')} of ${limit.toLocaleString('en')}`,
    override: 'Your value',
    overrideHint: (quantity: number, currency: string) =>
      `The value of the whole item${quantity === 1 ? '' : `, all ${quantity}`}, in ${currency}. It replaces the BrickLink price. Leave it blank to use BrickLink's. Only you see it.`,
    overrideSave: 'Save value',
    overrideSaving: 'Saving…',
    overrideSaved: 'Value saved.',
    overrideCleared: 'Your value was removed: the item uses the BrickLink price again.',
    overrideGone: 'This item is gone.',
    overrideProblem: {
      notANumber: 'Type an amount, such as 125 or 125.50.',
      tooLarge: (max: number) => `An amount up to ${max.toLocaleString('en')}.`,
      tooManyDecimals: 'At most two decimals.',
    },
    adjustments: 'Value adjustments',
    adjustmentsHint: 'A used item’s BrickLink price is adjusted by these percentages. A sealed item’s never is. Only you see them.',
    adjustUsedWithBox: 'Used, with box (%)',
    adjustUsedNoBox: 'Used, no box (%)',
    adjustRange: (min: number, max: number) => `A whole number from ${min} to ${max}.`,
    adjustSave: 'Save adjustments',
    adjustSaving: 'Saving…',
    adjustSaved: 'Adjustments saved.',
  },
  /**
   * `/admin/summary`, the printable catalogue (#236, #255, [EXP-5]): the summary, then every item,
   * and only what the catalogue would show.
   */
  summary: {
    title: 'Printable catalogue',
    /** The page's title, which browsers name a saved PDF after: no colon or slash in it. */
    documentTitle: (catalogue: string, madeAt: string) => `${catalogue} – catalogue – ${madeAt}`,
    print: 'Print',
    madeAt: (iso: string) =>
      `Made ${new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`,
    asPublished: 'It shows the catalogue as a publish would make it now, which can differ from the catalogue last published.',
    intro: 'About the collection',
    contact: 'Contact',
    contents: 'What it holds',
    segmentHeader: 'Segment',
    itemsHeader: 'Items',
    valueHeader: 'Estimated value',
    askingHeader: 'Asking price',
    segment: { sealed: 'Sealed', used: 'Used', parts: 'Loose parts and bulk lots' },
    all: 'Whole collection',
    items: (items: number, units: number) => `${plural(items, 'item', 'items')}${units === items ? '' : ` (${units.toLocaleString('en')} counted by quantity)`}`,
    parts: (lots: number, quantity: number) => `${plural(lots, 'lot', 'lots')} of loose parts · ${plural(quantity, 'part', 'parts')}`,
    money,
    empty: 'The catalogue holds nothing yet.',
    /** The item list after the summary (#255). */
    list: 'Every item',
    complete: 'Complete',
    incomplete: 'Incomplete',
    missing: (notes: string) => `Incomplete: ${notes}`,
    instructions: 'Instructions',
    noInstructions: 'No instructions',
    quantity: (quantity: number) => `×${quantity.toLocaleString('en')}`,
    coverAlt: (label: string) => `Photo of ${label}`,
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
  settings: {
    title: 'Settings',
    texts: 'Catalogue texts',
    textsHint: 'Plain text, shown to every visitor at the next publish.',
    intro: 'Intro',
    introHint: 'At the top of the catalogue.',
    contact: 'Contact',
    contactHint: 'At the bottom of the catalogue: how a visitor reaches you.',
    limit: (max: number) => `Up to ${max.toLocaleString('en')} characters.`,
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved. Publish to show the new texts in the catalogue.',
    tooLong: (max: number) => `This is longer than ${max.toLocaleString('en')} characters.`,
    notPlain: 'Plain text only: this holds a control character, often from a paste. Retype the text around it.',
    link: 'Catalogue link',
    linkHint: 'Only you see this address here. Anyone who has it can open the catalogue.',
    noLink: 'There is no catalogue link yet: it is made at the first publish.',
    rotate: 'Rotate catalogue link',
    rotating: 'Rotating…',
    rotateHint: 'Makes a new link and publishes the catalogue under it. The old link stops working.',
    confirmRotate:
      'Rotate the catalogue link? The catalogue is published under a new link, and the old link stops working for everyone who has it. This cannot be undone.',
    rotated: 'The catalogue link was rotated. The new link:',
    oldNotRemoved:
      'But the old link was not fully removed: it may keep working from the cache for up to a day. Publish again to finish removing it.',
    rotateFailed: 'Rotating the catalogue link failed.',
    rotateBusy: 'Another publish is running: wait for it to finish, then rotate again.',
    rotateKept: 'The old link still works, unchanged.',
    rotatePartial: 'The old link may no longer work: rotate again.',
    reference: (requestId: string) => `Reference: ${requestId}`,
    /** Show values, selling mode and the asking prices (#211). */
    values: {
      heading: 'Values in the catalogue',
      hint: 'Values and asking prices stay private unless you show them here. Changes go out at the next publish.',
      showValues: 'Show values',
      showValuesHint: 'Shows each item’s estimated market value, the totals and a sort by value. Ignored in selling mode.',
      sellingMode: 'Selling mode',
      sellingModeHint: 'Presents the catalogue as an offer: split views of sealed, used and loose parts, and a parts list to download.',
      display: 'What selling mode shows',
      displays: {
        ASKING: 'Asking prices only',
        MARKET: 'Market values only',
        BOTH: 'Asking prices and market values',
      },
      asking: 'Asking prices',
      askingHint: 'Shown only in selling mode, with asking prices on. Leave a field empty for none.',
      askingFields: {
        total: 'For everything',
        sealed: 'Sealed items',
        used: 'Used items',
        parts: 'Loose parts',
      },
      /** The maximum is written without separators, since the field refuses `1,500` (#219). */
      notAmount: (max: number) =>
        `Enter an amount from 0 to ${max}, such as 1500 or 1500.50, with at most two decimals and no comma or dot between thousands.`,
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. Publish to apply these settings to the catalogue.',
    },
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
