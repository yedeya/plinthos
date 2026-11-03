import { describe, expect, it } from 'vitest';
import { MAX_FAILED_ATTEMPTS, retryDelayMs } from '../../src/app/_offline/replay';
import { markdownSection, readRepoFile } from '../support/repo-file';

const guide = readRepoFile('docs/deploy.md');
const nvmrc = readRepoFile('.nvmrc').trim();
const stepOne = markdownSection(guide, '1. What you need').join('\n');
const stepTwo = markdownSection(guide, '2. Clone and install').join('\n');
const stepEight = markdownSection(guide, '8. Install the admin on your phone').join('\n');

/** The names of the packages the lockfile installs that run an install script. */
function packagesWithInstallScripts(): string[] {
  const lock = JSON.parse(readRepoFile('package-lock.json')) as {
    packages: Record<string, { hasInstallScript?: boolean }>;
  };
  const names = Object.entries(lock.packages)
    .filter(([, entry]) => entry.hasInstallScript === true)
    .map(([path]) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length));
  return [...new Set(names)];
}

// npm ci only warns on another Node.js version, so the guide is what keeps a reader on the
// pinned one, and what tells them which of npm ci's warnings to ignore (#109).
describe("docs/deploy.md's steps 1 and 2", () => {
  it('step 1 names the Node.js version .nvmrc pins, and the runtime the admin deploys to', () => {
    const runtime = /runtime: '(nodejs\d+\.x)'/.exec(readRepoFile('infra/admin.ts'))?.[1];
    expect(runtime).toBe(`nodejs${nvmrc}.x`);
    expect(stepOne).toContain(`Node.js ${nvmrc}`);
    expect(stepOne).toContain('`.nvmrc`');
    expect(stepOne).toContain(`\`${runtime}\``);
  });

  it('step 1 says how to switch to it, and that npm ci only warns on another version', () => {
    expect(stepOne).toContain('nvm install && nvm use');
    expect(stepOne).toContain('EBADENGINE');
  });

  it('step 2 names every package with an install script npm warns about', () => {
    const names = packagesWithInstallScripts();
    expect(names, 'the lockfile installs no package with an install script').not.toHaveLength(0);
    expect(stepTwo).toContain('allowScripts');
    for (const name of names) expect(stepTwo, name).toContain(`\`${name}\``);
  });

  it("step 2 links docs/dependency-audit.md for npm ci's audit summary and deprecations", () => {
    expect(stepTwo).toContain('](dependency-audit.md)');
    expect(stepTwo).toMatch(/npm audit/);
    expect(stepTwo).toMatch(/deprecat/i);
  });
});

/** A count as the guide writes it in prose, and a backoff in its largest whole unit. */
const COUNT_WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };
function duration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  return `${ms / 1000} seconds`;
}

// Step 8 is what the owner reads about a change the server did not apply. It drifted once from
// the replay's retry of a failed change (#87, #98), so it is held to the replay's own constants.
describe("docs/deploy.md's step 8", () => {
  /** The bullet of step 8 that mentions `needle`. */
  const bullet = (needle: string) => stepEight.split('\n').find((line) => line.startsWith('- ') && line.includes(needle)) ?? '';

  it('holds a conflict or an invalid change at once, with Retry and Discard, and the rest waits behind it', () => {
    const held = bullet('held at once');
    expect(held).toMatch(/invalid/);
    expect(held).toContain('*Retry* and *Discard*');
    expect(held).toMatch(/nothing queued after it syncs/);
  });

  it('retries a failed change by itself after a backoff, never on a timer, and holds it after the last failure', () => {
    const failed = bullet('failed on the server');
    expect(failed, 'step 8 has no bullet for a change that failed on the server').not.toBe('');
    expect(failed).toMatch(/by itself/);
    expect(failed).toContain('never on a timer');
    for (let failures = 1; failures < MAX_FAILED_ATTEMPTS; failures += 1) {
      expect(failed, `the backoff after failure ${failures}`).toContain(duration(retryDelayMs(failures)));
    }
    expect(failed).toContain(`After ${COUNT_WORDS[MAX_FAILED_ATTEMPTS]} failures`);
    expect(failed).toContain('*Retry* and *Discard*');
    expect(failed).toMatch(/queued after it waits behind it/);
  });
});

// Step 4 cost the first deployment an afternoon of BrickLink's SIGNATURE_INVALID: its token form
// asks for an IP mask the guide didn't name, and a secret set again reached nothing until the next
// deploy, so the old keys kept being sent (#220).
describe("docs/deploy.md's step 4", () => {
  const stepFour = markdownSection(guide, '4. SST secrets').join('\n');
  const brickLink = stepFour.slice(stepFour.indexOf('**The BrickLink keys.**'), stepFour.indexOf('**The password hash.**'));

  it('names the IP mask 0.0.0.0 beside the IP address for the BrickLink access token', () => {
    expect(brickLink, 'step 4 has no BrickLink paragraph').not.toBe('');
    expect(brickLink).toMatch(/IP mask `0\.0\.0\.0`/);
  });

  it('says a set or changed secret reaches the server and sst shell only after npx sst deploy', () => {
    const rule = stepFour.split('\n\n').find((paragraph) => paragraph.includes('`sst shell`')) ?? '';
    expect(rule, 'step 4 has no paragraph about sst shell').not.toBe('');
    expect(rule).toContain('npx sst deploy --stage production');
    expect(rule).toMatch(/server/);
    expect(rule).toMatch(/only after/);
  });

  it('says a reissued consumer key needs a new access token too', () => {
    expect(brickLink).toMatch(/reissue[^.]*consumer key[^.]*new access token/i);
  });
});

// .nvmrc is part of each tag, so a reader who changes refs in the same shell must switch
// Node.js again before installing, or a release that changes .nvmrc builds on the old one (#116).
describe('docs/deploy.md, wherever it changes the checked-out ref', () => {
  const refChange = /git (?:clone|checkout|switch)\b/g;
  const changes = [...guide.matchAll(refChange)].map((match) => match.index);

  it('finds the clone in step 2 and the release checkouts in steps 2 and 5', () => {
    expect(changes.length).toBeGreaterThanOrEqual(3);
  });

  it("switches to the ref's .nvmrc Node.js version before the npm ci that follows", () => {
    for (const start of changes) {
      const install = guide.indexOf('npm ci', start);
      const context = guide.slice(start, start + 60).split('\n')[0];
      expect(install, `no npm ci follows ${context}`).toBeGreaterThan(start);
      expect(guide.slice(start, install), context).toContain('nvm install && nvm use');
    }
  });
});
