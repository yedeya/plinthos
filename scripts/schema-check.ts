/**
 * The schema check ([PLAT-11]): fails when the schema in `src/db/schema/` holds a change that the
 * committed migrations in `drizzle/` don't, or when the migrations' snapshots disagree with each
 * other. CI runs it as its own gate (`npm run db:check`, `docs/qa/stack.md`).
 *
 * It runs `drizzle-kit generate` into a copy of `drizzle/`, so the committed folder is never
 * written, and fails if that would add a migration. The copy sits in the repository, under an
 * ignored `.schema-check-*` name, because drizzle-kit takes only a relative output folder. Then
 * it runs `drizzle-kit check` over the committed folder. Neither reaches a database.
 *
 *   tsx scripts/schema-check.ts [schema]   the schema defaults to src/db/schema/index.ts
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const schema = process.argv[2] ?? './src/db/schema/index.ts';

function drizzleKit(command: 'generate' | 'check', out: string): { status: number | null; output: string } {
  const result = spawnSync('npx', ['drizzle-kit', command, '--config', 'drizzle.config.ts'], {
    env: { ...process.env, DRIZZLE_SCHEMA: schema, DRIZZLE_OUT: out },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Every file under `dir`, as paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

/** Runs the check, and answers whether the committed migrations hold every schema change. */
function check(copy: string): boolean {
  cpSync('drizzle', copy, { recursive: true });
  const before = files(copy);
  const generated = drizzleKit('generate', copy);
  // drizzle-kit can fail and still exit 0, so a run that adds nothing must also say so.
  const added = files(copy).filter((file) => !before.includes(file));
  if (generated.status !== 0 || (added.length === 0 && !/No schema changes/.test(generated.output))) {
    console.error(generated.output);
    console.error('schema check: drizzle-kit generate failed.');
    return false;
  }
  if (added.length > 0) {
    console.error(
      `schema check: the schema holds changes no committed migration does. Generating would add:\n${added.map((file) => `  drizzle/${file}`).join('\n')}`,
    );
    console.error('Run `npm run db:generate` and commit the migration it writes ([PLAT-11]).');
    return false;
  }
  const checked = drizzleKit('check', 'drizzle');
  if (checked.status !== 0) {
    console.error(checked.output);
    console.error('schema check: drizzle-kit check found the committed migrations inconsistent.');
    return false;
  }
  console.log('schema check: the committed migrations hold every schema change.');
  return true;
}

const copy = mkdtempSync('.schema-check-');
try {
  if (!check(copy)) process.exitCode = 1;
} finally {
  rmSync(copy, { recursive: true, force: true });
}
