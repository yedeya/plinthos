# Escalation paths

The paths whose changes go to the Owner rather than to the Merger alone (`K-LAYOUT-8`, `K-MERGE-4`). They are the walking-skeleton brief's decision 7 (`docs/projects/6.md`), with `src/server/sync/` and `src/server/photos/` added by the Owner on #10. `[DEV-6]` names them, and `tests/tooling/escalation-paths.test.ts` holds this list to it.

The pipeline's own paths escalate whatever this file says: everything under `.github/`, every markdown file directly inside `docs/qa/` (this one included), `AGENTS.md`, `CLAUDE.md` and `.claude/`.

## Escalation paths

- `^sst\.config\.ts$` `infra` — the SST app: every AWS resource, its cost and its permissions
- `^infra/` `infra` — the SST modules `sst.config.ts` composes
- `^drizzle/` `migrations` — the database migrations, which run against production on every release
- `^src/db/schema/` `schema` — the database schema
- `^src/server/auth/` `auth` — the admin's sign-in, sessions and rate limiting
- `^src/server/publish/projection` `other` — the publish step's public projection, the one thing that decides what leaves the private side
- `^src/server/sync/` `other` — the offline-sync endpoint, a write path into every service function
- `^src/server/photos/` `other` — the photo pipeline, which re-encodes every upload and removes its quarantined original

`## Pipeline code` and `## Bail list` are left out on purpose: the project keeps no pipeline scripts of its own, and its bail list is Kanon's default with no additions (decision 7).
