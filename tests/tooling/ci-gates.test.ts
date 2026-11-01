import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { markdownSection, readRepoFile } from '../support/repo-file';

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
// command does; `docs/qa/stack.md` lists the same commands in the same order ([DEV-2]).
const GATES = [
  { job: 'typecheck', command: 'npm run typecheck' },
  { job: 'lint', command: 'npm run lint' },
  { job: 'test', command: 'npm test' },
];

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

  it('[DEV-1] runs the typecheck, lint and test gates each as its own job, and a failure of any one fails the run', () => {
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
