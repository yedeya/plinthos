# Stack

The project's stack document (`K-LAYOUT-17`), started by `kanon init`. The sections it leaves out mean their documented defaults: no schema changes and nothing to isolate.

TypeScript on Node.js, the version `.nvmrc` pins, with npm. Strict `tsc --noEmit`, ESLint's flat config (`eslint.config.js`) and Vitest (`vitest.config.ts`). The toolchain and the layout are the walking-skeleton brief's decisions 11 and 12 (`docs/projects/6.md`).

## Gates

Run these from the repository root, in this order, before you push. They are exactly the commands CI's `Typecheck`, `Lint` and `Test` jobs run, in the order `.github/workflows/ci.yml` declares them (`[DEV-2]`), and `tests/tooling/ci-gates.test.ts` fails when the two disagree.

1. `npm run typecheck` — first installs SST's types into `.sst/platform` (`sst install` against `sst.types.config.ts`, which reaches no AWS and needs no deployment configuration), then runs strict `tsc --noEmit` over `src/`, `tests/` and the configuration files, then `tsc --noEmit -p infra` over `sst.config.ts`, `infra/` and `tests/infra/`. That second project relaxes `noUncheckedIndexedAccess` and `noImplicitOverride` alone, because SST's types are TypeScript sources that don't compile under them (`infra/tsconfig.json`). npm runs the first and last steps as the `pretypecheck` and `posttypecheck` scripts.
2. `npm run lint` — ESLint over the whole repository. Under `tests/` it refuses the static ways to leave a test out: `.skip`, `.skipIf`, `.runIf`, `.todo` and `.only` on `it`, `test`, `describe` or `suite` (also further down a chain, as in `it.concurrent.skip`), importing those under another name or the test API as a namespace, and a test or hook calling its context's `skip` (`[DEV-3]`).
3. `npm test` — every Vitest test under `tests/`. The database tests need the test PostgreSQL at `DATABASE_URL`, which the project-setup hook starts in CI and in every lane (`docs/qa/test-database.md`). Without it they **fail**, by design, rather than skip (`[DEV-3]`). The run also fails when any test ends skipped or todo, however it got there (`tests/support/every-test-runs.ts`), unless you filtered it yourself with `-t`, a line number or a tag. To run them on your own machine, start the same server and export its URL:

   ```sh
   docker run -d --name test-database -e POSTGRES_USER=plinthos -e POSTGRES_PASSWORD=plinthos -e POSTGRES_DB=plinthos -p 5432:5432 postgres:16-alpine
   export DATABASE_URL=postgres://plinthos:plinthos@localhost:5432/plinthos
   ```

Run `npm ci` first if `node_modules/` is missing or `package-lock.json` changed.

## Generated files

- `package-lock.json` — npm writes it from `package.json`. After a merge conflict in it, resolve `package.json` first, take either side of the lockfile, then run `npm install --package-lock-only` and commit the result. Never edit it by hand.

## Code areas

- `src/` — code: the application, Next.js under `src/app/`, the typed service core under `src/server/` and the schema and client under `src/db/`
- `infra/` — code: the SST modules `sst.config.ts` composes
- `tests/` `vitest` — tests: unit, integration and tooling tests, and their support code under `tests/support/`
