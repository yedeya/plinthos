# Dependency audit

What `npm audit` reports against `package-lock.json`, and what was done about each high or critical advisory. A high or critical advisory is either resolved, or recorded here with why it can't be reached in the deployed app or in the deploy job that holds the AWS credential. `tests/tooling/dependency-advisories.test.ts` fails when the lockfile installs a version that a resolved advisory affects.

## 2026-11-01

`npm audit` after `@opennextjs/aws` 4.1.14 arrived (PR #32): **3 high, 15 moderate, no critical.** `npm audit --omit=dev` finds none: nothing in the deployed admin's own dependencies (`next`, `react`, `drizzle-orm`, the AWS SDK, `pino`, `zod`) carries an advisory.

### High: resolved

The three highs are one advisory, reported once for the package and once for each package above it in the chain:

| Advisory | Package | Chain | Resolution |
|---|---|---|---|
| [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2): glob's CLI runs the matches of `-c/--cmd` with `shell: true` | `glob` 10.3.3 (affected: `>=10.2.0 <10.5.0`) | `@opennextjs/aws` → `@node-minify/core` 9.0.2 → `glob` | `package.json`'s `overrides` lift `@node-minify/core`'s `glob` to 10.5.0, the same major |

The override is needed because `@opennextjs/aws`, up to its latest release 4.1.14, asks for `@node-minify/core` `^9.0.2`, and 9.0.2 is the last 9.x release, which pins `glob` to exactly 10.3.3. `npm audit` suggests downgrading `@opennextjs/aws` to 4.1.8, a step backwards, and the override makes that unnecessary. Before the override the advisory was unreachable anyway: `@node-minify/core` calls glob's `globSync` API and never its CLI, and only in OpenNext's minifier, which runs inside `npm run build`. That build runs without any credential (`[PLAT-4]`, `docs/deploy.md`). The minifier still works with glob 10.5.0. It was checked by running OpenNext's `minifyAll` over a file, and `npm run build` still completes.

Drop the override when `@node-minify/core` (or `@opennextjs/aws`) no longer installs an affected `glob`, along with its entry in the test.

### Moderate: open, development and build tooling only

None of these is installed in the deployed app, and none runs in the deploy job beside the AWS credential.

| Advisory | Package | Brought in by | Why it isn't reached |
|---|---|---|---|
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99): esbuild's development server answers any website's requests | `esbuild` 0.18.20 | `drizzle-kit` → `@esbuild-kit/esm-loader` | `drizzle-kit` only generates and checks migrations. It never starts esbuild's development server |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): denial of service through glob-pattern amplification | `minimatch` 9.0.9 and 10.2.6 | `eslint`, `typescript-eslint`, `glob` | The patterns come from the repository's own configuration, never from a visitor |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): a cancelled glob keeps walking the filesystem | `glob` 10.5.0 (affected: `>=9.0.0 <=14.0.1`) | `@opennextjs/aws` → `@node-minify/core` | The minifier passes no `AbortSignal`, and it walks only the build's own output |

With the high resolved, `npm audit` reports 18 moderates and no high. The three that move up from high to moderate are the same `glob` chain, which GHSA-3g3m-2fjr-6pw4 still flags.
