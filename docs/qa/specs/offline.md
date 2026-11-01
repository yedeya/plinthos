# Offline entry

Entering data without a signal: the installable admin shell, the queue on the owner's device, and the offline-sync endpoint that replays it through the typed service core (`AGENTS.md` §4, `HANDOVER.md` §10.7). Seeded by the walking-skeleton project (#6), whose decision 2 put offline entry in the skeleton. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `SYNC`

## The sync endpoint

- `[SYNC-1]` `[seed]` The offline-sync endpoint is an admin route that takes a batch of queued mutations, validates each one with the zod schema of the service function it names, and applies it only by calling that service function with the session's `AdminContext`; a mutation that names no registered service function is refused as invalid.
- `[SYNC-2]` `[seed]` Every mutation carries a client-generated UUID, and the record that the id was applied is written in the same transaction as the change it made; a mutation whose id was already applied with the same payload changes nothing and returns the first result.
- `[SYNC-3]` `[seed]` A mutation whose id was already applied with a different payload, or whose base version differs from the server's current version of the record it changes, is not applied; the endpoint returns it as a conflict with the server's current version, and logs the `businessEvent` `sync.conflict` with the mutation id and the service function's name and never the payload.
- `[SYNC-4]` `[seed]` The mutations of a batch are applied in the order the client queued them, each in its own transaction, and the response names each one's outcome (applied, already applied, conflict, invalid or failed); a mutation that fails on the server logs the `businessEvent` `sync.mutation.failed` with its id.

## The installable shell

- `[SYNC-5]` `[seed]` The admin is an installable web app: it serves a web app manifest and registers a service worker, and an installed admin with no network opens to its shell and its queue.
- `[SYNC-6]` `[seed]` The service worker caches only the app shell and the static build assets; it never caches a response to a request that carries the session cookie or a response from an admin route handler, and a test of its fetch handler fails when one is cached.

## The queue

- `[SYNC-7]` `[seed]` A change made without a network is kept in an IndexedDB queue on the device, survives a reload and a restart of the browser, and is replayed when the network returns and when the admin is opened; the client asks the browser for persistent storage.
- `[SYNC-8]` `[seed]` A queued mutation leaves the queue only when the server answers it as applied or already applied. When replay meets an ended session, it stops, sends the admin to the login, and resumes after sign-in; a conflict, an invalid or a failed mutation stays in the queue and is shown on `/admin` until the admin retries or discards it.
- `[SYNC-9]` `[seed]` Logout with a non-empty queue says how many mutations are not yet synced, and once the admin confirms, clears the queue and every cache the service worker holds.
