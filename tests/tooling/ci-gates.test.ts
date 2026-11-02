import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { markdownSection, readRepoFile, repoRoot } from '../support/repo-file';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  'continue-on-error'?: unknown;
}

interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  steps: Step[];
  'continue-on-error'?: unknown;
}

interface Workflow {
  on: Record<string, { branches?: string[] } | null>;
  jobs: Record<string, Job>;
}

const ci = parse(readRepoFile('.github/workflows/ci.yml')) as Workflow;

// The project's own gates and the command each job runs. `package.json` holds what each
// command does, but for spec coverage, which is Kanon's script (#52); `docs/qa/stack.md` lists
// the same commands in the same order ([DEV-2]).
const SPEC_COVERAGE = 'node "$KANON/scripts/spec-coverage.mjs" --quiet';
const GATES = [
  { job: 'typecheck', command: 'npm run typecheck' },
  { job: 'lint', command: 'npm run lint' },
  { job: 'test', command: 'npm test' },
  { job: 'schema', command: 'npm run db:check' },
  { job: 'spec-coverage', command: SPEC_COVERAGE },
];

/** The release a `yedeya-labs/kanon/actions/<name>` step of a job pins, if it has one. */
function kanonPin(job: Job | undefined, action: string): string | undefined {
  const prefix = `yedeya-labs/kanon/actions/${action}@`;
  return job?.steps.find((step) => step.uses?.startsWith(prefix))?.uses?.slice(prefix.length);
}

/** Every `run` step of every job, in the order the workflow declares them. */
function ciCommands(): string[] {
  return Object.values(ci.jobs).flatMap((job) =>
    job.steps.filter((step) => step.run !== undefined).map((step) => (step.run ?? '').trim()),
  );
}

/** The commands `## Gates` lists, one numbered item each, in its order. */
function stackGates(): string[] {
  return markdownSection(readRepoFile('docs/qa/stack.md'), 'Gates')
    .map((line) => /^\d+\. `([^`]+)`/.exec(line)?.[1])
    .filter((command): command is string => command !== undefined);
}

describe('CI gates', () => {
  it('[DEV-1] runs on every pull request and every push to main', () => {
    expect(Object.keys(ci.on)).toContain('pull_request');
    expect(ci.on.pull_request).toBeNull();
    expect(ci.on.push?.branches).toContain('main');
  });

  it('[DEV-1] runs the typecheck, lint, test, schema-check and spec-coverage gates each as its own job, and a failure of any one fails the run', () => {
    for (const { job: id, command } of GATES) {
      const job = ci.jobs[id];
      expect(job, `ci.yml has no \`${id}\` job`).toBeDefined();
      if (job === undefined) continue;
      // Nothing may let the run pass without the gate: no condition on the job or its steps,
      // no tolerated failure, and no dependency that could skip it.
      expect(job.if, `${id}: the job is conditional`).toBeUndefined();
      expect(job.needs, `${id}: the job waits on another and is skipped when it fails`).toBeUndefined();
      expect(job['continue-on-error'], `${id}: the job tolerates failure`).toBeUndefined();
      for (const step of job.steps) {
        expect(step.if, `${id}: a step is conditional`).toBeUndefined();
        expect(step['continue-on-error'], `${id}: a step tolerates failure`).toBeUndefined();
      }
      const runs = job.steps.filter((step) => step.run !== undefined).map((step) => step.run?.trim());
      expect(runs, `${id}: the job runs exactly its gate`).toEqual([command]);
    }
  });

  // The ratchet on docs/qa/specs/_locked-floor.json (#52): the job runs the script of the Kanon
  // release the lane check pins, so a pin move moves both, and the pull request's branch can't
  // change the script it is checked by.
  it('runs spec coverage from the Kanon release the lane check pins, after it puts that release in KANON', () => {
    const job = ci.jobs['spec-coverage'];
    const release = kanonPin(ci.jobs.lanes, 'lane-check');
    expect(release, 'the lane check pins no exact Kanon release').toMatch(/^v\d+\.\d+\.\d+$/);
    expect(kanonPin(job, 'kanon-path'), 'the job finds Kanon at another release').toBe(release);
    const steps = job?.steps ?? [];
    const pathStep = steps.findIndex((step) => step.uses?.startsWith('yedeya-labs/kanon/actions/kanon-path@'));
    const runStep = steps.findIndex((step) => step.run?.trim() === SPEC_COVERAGE);
    expect(pathStep, 'the job runs the script before KANON is set').toBeLessThan(runStep);
  });

  // What the comment above the gate jobs in ci.yml says (#107): the npm gates install through
  // the hook the lanes call, so a broken hook fails CI first; spec coverage installs nothing.
  it('installs the project for each npm gate through the project-setup hook, and for spec coverage not at all', () => {
    for (const { job: id, command } of GATES) {
      const uses = (ci.jobs[id]?.steps ?? []).map((step) => step.uses);
      if (command.startsWith('npm ')) {
        expect(uses, `${id}: the gate installs without the hook`).toContain('./.github/actions/project-setup');
      } else {
        expect(uses, `${id}: the gate installs the project`).not.toContain('./.github/actions/project-setup');
      }
    }
  });

  it('[DEV-1] names each gate command in package.json, with typecheck as strict tsc --noEmit', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
    expect(pkg.scripts.lint).toBe('eslint .');
    expect(pkg.scripts.test).toBe('vitest run');
    const tsconfig = JSON.parse(readRepoFile('tsconfig.json')) as { compilerOptions: { strict?: boolean } };
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it('[DEV-2] ## Gates in docs/qa/stack.md lists exactly the commands CI runs, in the order CI declares them', () => {
    expect(stackGates()).toEqual(ciCommands());
    expect(stackGates()).toEqual(GATES.map((gate) => gate.command));
  });

  it('[DEV-2] each gate is a single command a person can paste into a shell', () => {
    for (const command of stackGates()) {
      expect(command, command).not.toMatch(/\n|&&|\|\||;|\||\$\{\{/);
    }
  });
});

/** The files a TypeScript project type-checks: its sources, and its JavaScript only under `checkJs`. */
function typeChecked(project: string): string[] {
  const path = join(repoRoot, project);
  const { config, error } = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  expect(error, `${project} does not parse`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(path));
  return parsed.fileNames.filter((file) => !/\.[cm]?jsx?$/.test(file) || parsed.options.checkJs === true);
}

describe('The typecheck gate', () => {
  // docs/qa/stack.md says `npm run typecheck` checks the configuration files: between them the
  // root project and infra/'s check every one at the root of the repository, JavaScript included.
  it('type-checks every configuration file at the root of the repository', () => {
    const checked = new Set([...typeChecked('tsconfig.json'), ...typeChecked('infra/tsconfig.json')]);
    const configFiles = readdirSync(repoRoot).filter((name) => /\.config\.[cm]?[jt]s$/.test(name));
    expect(configFiles).toContain('eslint.config.js');
    for (const name of configFiles) {
      expect(checked.has(join(repoRoot, name)), `${name} is not type-checked`).toBe(true);
    }
  });
});
