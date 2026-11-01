# Operations

Logging, the signals that notify the owner, and the document that says what each one means (`AGENTS.md` §2, `K-OBS-2`, `K-LAYOUT-5`). Seeded by the walking-skeleton project (#6). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `OPS`

## Logging

- `[OPS-1]` `[seed]` Server code logs through one pino logger, as one JSON line per event; a `businessEvent` field names the events that matter in dot-separated lowercase, and lint refuses a `console` call in server code.
- `[OPS-2]` `[seed]` The logger redacts session ids, cookies, passwords, password hashes and secrets: a test logs each of them and finds none in the output.

## Signals

- `[OPS-3]` `[seed]` `docs/observability.md` holds the three tables `K-LAYOUT-5` anchors; every alarm `sst.config.ts` defines is a row of the paged table and every paged row has its alarm, and every `businessEvent` the code emits is in exactly one of the paged and the not-paged tables.
- `[OPS-4]` `[seed]` Every alarm and the budget notify one SNS topic, whose e-mail subscriber comes from the deployment's configuration.
- `[OPS-5]` `[seed]` When the admin's server code fails a request, it logs one error line with the `businessEvent` `admin.request.failed` and a request id, and the page the admin sees names that request id.
- `[OPS-6]` `[seed]` A publish that fails leaves the previous snapshot in place, tells the admin who started it that it failed, and logs the `businessEvent` `catalogue.publish.failed`.
- `[OPS-7]` `[seed]` An alarm notifies the topic when the Aurora cluster has not paused for 12 consecutive hours.
