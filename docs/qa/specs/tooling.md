# Tooling

The gates every change passes and the project-setup hook every lane runs: what makes the repository buildable and testable by someone other than its author. Seeded by the walking-skeleton project (#6). Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `DEV`

## CI gates

- `[DEV-1]` `[seed]` CI runs the typecheck, lint and test gates on every pull request and every push to `main`, each as its own job of `.github/workflows/ci.yml`, and a failure of any one of them fails the run.
- `[DEV-2]` `[seed]` `## Gates` in `docs/qa/stack.md` lists exactly the commands CI runs for those gates, in the order CI runs them, each one a single command a person can paste into a shell.
- `[DEV-3]` `[seed]` A test that needs the database fails when `DATABASE_URL` is unset or the database does not answer; no test is skipped for want of a database.

## The project-setup hook

- `[DEV-4]` `[seed]` Given `database: 'true'`, the project-setup hook installs the Node.js version the repository pins and the locked dependencies, starts a PostgreSQL server of the same major version as the Aurora engine `sst.config.ts` deploys, and writes its connection string to `$GITHUB_ENV` as `DATABASE_URL` before it finishes (`K-LAYOUT-16`).
- `[DEV-5]` `[seed]` Given `database: 'false'`, the project-setup hook installs the toolchain and the dependencies and starts no database.

## Escalation

- `[DEV-6]` `[seed]` `docs/qa/escalation-paths.md` declares as escalation paths the infrastructure code, the database schema and its migrations, the authentication and session code, the publish step's public projection, the offline-sync endpoint (`src/server/sync/`) and the photo pipeline (`src/server/photos/`), each with its category from `K-LAYOUT-8`'s list, and `lane-check` accepts the file.
