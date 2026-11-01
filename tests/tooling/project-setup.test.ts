import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { auroraPostgresMajor } from '../support/aurora';
import { readRepoFile } from '../support/repo-file';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
}

interface CompositeAction {
  inputs: Record<string, { default?: string }>;
  runs: { using: string; steps: Step[] };
}

const hook = parse(readRepoFile('.github/actions/project-setup/action.yml')) as CompositeAction;

// What Kanon's lanes pass the hook (docs/lanes.md, "The project-setup hook"). Every lane that
// installs passes `install: 'true'`; `database` is what docs/qa/test-database.md declares.
const LANE_INPUTS = ['lane', 'install', 'database', 'browsers', 'issue-number', 'app-slug', 'github-token'];

/**
 * Evaluates a step's `if:` for the given inputs. The hook's conditions are kept to comparisons
 * of one input with a string, so this reads exactly that and refuses anything else.
 */
function runsWith(step: Step, inputs: Record<string, string>): boolean {
  if (step.if === undefined) return true;
  const condition = step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  const match = /^inputs\.([\w-]+)\s*(==|!=)\s*'([^']*)'$/.exec(condition);
  if (match === null) throw new Error(`the hook has a condition this test cannot read: ${step.if}`);
  const [, name, operator, value] = match;
  const actual = inputs[name ?? ''] ?? hook.inputs[name ?? '']?.default ?? '';
  return operator === '==' ? actual === value : actual !== value;
}

function stepsFor(database: 'true' | 'false'): Step[] {
  return hook.runs.steps.filter((step) => runsWith(step, { lane: 'test', install: 'true', database }));
}

function startsTheToolchain(steps: Step[]): void {
  const node = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  expect(node, 'no step installs Node.js').toBeDefined();
  expect(node?.with?.['node-version-file']).toBe('.nvmrc');
  expect(steps.map((step) => step.run?.trim())).toContain('npm ci');
}

const mentionsDatabase = (step: Step): boolean => /docker|postgres|DATABASE_URL/i.test(`${step.uses ?? ''} ${step.run ?? ''}`);

describe('the project-setup hook', () => {
  it('declares every input Kanon\'s lanes pass it', () => {
    expect(hook.runs.using).toBe('composite');
    for (const input of LANE_INPUTS) expect(Object.keys(hook.inputs)).toContain(input);
  });

  it('[DEV-4] pins one Node.js version in .nvmrc and package.json engines, with a lockfile to install from', () => {
    const nvmrc = readRepoFile('.nvmrc').trim();
    expect(nvmrc).toMatch(/^\d+$/);
    const pkg = JSON.parse(readRepoFile('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`^${nvmrc}`);
    const lock = JSON.parse(readRepoFile('package-lock.json')) as { lockfileVersion: number };
    expect(lock.lockfileVersion).toBe(3);
  });

  it('[DEV-4] given database true, installs the pinned Node.js and the locked dependencies', () => {
    startsTheToolchain(stepsFor('true'));
  });

  it('[DEV-4] given database true, starts PostgreSQL of the Aurora engine\'s major version and writes DATABASE_URL to $GITHUB_ENV', () => {
    const steps = stepsFor('true');
    const scripts = steps.map((step) => step.run ?? '').join('\n');
    const images = [...scripts.matchAll(/\bpostgres:(\d+)(?:[.\-\w]*)/g)].map((match) => Number(match[1]));
    expect(images, 'no step starts a postgres image').not.toHaveLength(0);
    for (const major of images) expect(major).toBe(auroraPostgresMajor());
    expect(scripts).toMatch(/DATABASE_URL=postgres(ql)?:\/\/\S+["']?\s*>>\s*"\$GITHUB_ENV"/);
    // It waits for the server to answer before it finishes, so the lane's tests find it ready.
    expect(scripts).toMatch(/pg_isready/);
    const last = steps.at(-1);
    expect(last?.run ?? '', 'DATABASE_URL is written by the hook\'s last step, once the server is ready').toMatch(/GITHUB_ENV/);
  });

  it('[DEV-5] given database false, installs the toolchain and the dependencies and starts no database', () => {
    const steps = stepsFor('false');
    startsTheToolchain(steps);
    expect(steps.filter(mentionsDatabase)).toEqual([]);
  });
});
