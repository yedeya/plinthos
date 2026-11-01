# Stack

The project's stack document (`K-LAYOUT-17`), started by `kanon init`. The sections it leaves out mean their documented defaults.

TypeScript on Node.js, the version `.nvmrc` pins, with npm. Strict `tsc --noEmit`, ESLint's flat config (`eslint.config.js`) and Vitest (`vitest.config.ts`). The toolchain and the layout are the walking-skeleton brief's decisions 11 and 12 (`docs/projects/6.md`).

## Gates

Run these from the repository root, in this order, before you push. They are exactly the commands CI's `Typecheck`, `Lint`, `Test` and `Schema check` jobs run, in the order `.github/workflows/ci.yml` declares them (`[DEV-2]`), and `tests/tooling/ci-gates.test.ts` fails when the two disagree.

1. `npm run typecheck` — first installs SST's types into `.sst/platform` (`sst install` against `sst.types.config.ts`, which reaches no AWS and needs no deployment configuration), then runs strict `tsc --noEmit` over `src/`, `scripts/`, `tests/` and the other configuration files at the root, `eslint.config.js` included (`checkJs`), then `tsc --noEmit -p infra` over `sst.config.ts`, `sst.types.config.ts`, `infra/` and `tests/infra/`. `tests/tooling/ci-gates.test.ts` fails when a configuration file at the root is in neither project. That second project relaxes `noUncheckedIndexedAccess` and `noImplicitOverride` alone, because SST's types are TypeScript sources that don't compile under them (`infra/tsconfig.json`). npm runs the first and last steps as the `pretypecheck` and `posttypecheck` scripts.
2. `npm run lint` — ESLint over the whole repository. Under `tests/` it refuses the static ways to leave a test out: `.skip`, `.skipIf`, `.runIf`, `.todo` and `.only` on `it`, `test`, `describe` or `suite` (also further down a chain, as in `it.concurrent.skip`), importing those under another name or the test API as a namespace, and a test or hook calling its context's `skip` (`[DEV-3]`).
3. `npm test` — every Vitest test under `tests/`. The database tests need the test PostgreSQL at `DATABASE_URL`, which the project-setup hook starts in CI and in every lane (`docs/qa/test-database.md`). Without it they **fail**, by design, rather than skip (`[DEV-3]`). The run also fails when any test ends skipped or todo, however it got there (`tests/support/every-test-runs.ts`), unless you filtered it yourself with `-t`, a line number or a tag. To run them on your own machine, start the same server and export its URL:

   ```sh
   docker run -d --name test-database -e POSTGRES_USER=plinthos -e POSTGRES_PASSWORD=plinthos -e POSTGRES_DB=plinthos -p 5432:5432 postgres:16-alpine
   export DATABASE_URL=postgres://plinthos:plinthos@localhost:5432/plinthos
   ```

4. `npm run db:check` — the schema check (`[PLAT-11]`, `scripts/schema-check.ts`). It runs `drizzle-kit generate` into a copy of `drizzle/` and fails when that would add a migration, that is, when `src/db/schema/` holds a change no committed migration does; then `drizzle-kit check` over `drizzle/`. It reaches no database. When it fails, follow `## Schema changes`.

Run `npm ci` first if `node_modules/` is missing or `package-lock.json` changed.

## Schema changes

The schema is Drizzle's, in `src/db/schema/`; the migrations are in `drizzle/`, applied in order by Drizzle's migrator (`[PLAT-11]`). After you change the schema:

1. Run `npm run db:generate`. It writes the next migration and its snapshot into `drizzle/`, from the schema alone, without a database. Commit both with the schema change. For a change Drizzle can't express, such as inserting rows, run `npx drizzle-kit generate --custom --name <what-it-does>` and write the SQL into the empty migration it makes.
2. Classify every new column public or private in `src/db/schema/classification.ts` (`[PUB-3]`, `## Data isolation`).
3. Give every new table a UUID primary key that the application makes, with `.$defaultFn(() => randomUUID())`, never a sequence or a database default (`[PLAT-13]`).
4. Run the gates: `npm run db:check` must pass, and `npm test` applies every migration to an empty test database and compares the result with the schema.

Never edit a migration that has merged: production applied it on its next deploy. Change the schema again and generate a new one.

**The deploy step a pull request states for one:** none by hand. Every deploy applies the pending migrations through the Data API after `sst deploy` and before the smoke check, and a second run applies none (`[PLAT-12]`): `npx sst shell --stage production -- npm run db:migrate`, in `docs/deploy.md`'s step 5 and in the deploy hook. A pull request whose migration rewrites or drops data says so, and what the deploy does to existing rows; the walking skeleton has none.

## Data isolation

The rules a change must never regress, each with the test that proves it holds. Request changes on a pull request that weakens one of these tests or the rule it checks:

- **Every column is classified public or private, in one registry** (`[PUB-3]`): `src/db/schema/classification.ts`, held by `tests/db/classification.test.ts`. A column with no classification, in the schema or in the migrated database, fails it, and so does a value or a price classified public. Regressions: a change that lets an unclassified column through, that narrows what the test reads, or that makes a value, a price, a storage location or a note public.

## Generated files

- `package-lock.json` — npm writes it from `package.json`. After a merge conflict in it, resolve `package.json` first, take either side of the lockfile, then run `npm install --package-lock-only` and commit the result. Never edit it by hand.
- `drizzle/*.sql` and `drizzle/meta/` — `npm run db:generate` writes each migration and its snapshot from `src/db/schema/`; only a custom migration's SQL is written by hand. After a merge conflict there, keep `main`'s migrations as they are, delete your branch's generated migration and its snapshot and their entry in `drizzle/meta/_journal.json`, then run `npm run db:generate` again and commit the result. Never renumber or edit a merged migration.

## Code areas

- `src/` — code: the application, Next.js under `src/app/`, the typed service core under `src/server/` and the schema and client under `src/db/`
- `infra/` — code: the SST modules `sst.config.ts` composes
- `scripts/` — code: the deploy's migration step and the schema check, which run outside the application
- `tests/` `vitest` — tests: unit, integration and tooling tests, and their support code under `tests/support/`
