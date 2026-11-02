import { describe, expect, it } from 'vitest';
import { markdownSection, readRepoFile } from '../support/repo-file';

const guide = readRepoFile('docs/deploy.md');
const nvmrc = readRepoFile('.nvmrc').trim();
const stepOne = markdownSection(guide, '1. What you need').join('\n');
const stepTwo = markdownSection(guide, '2. Clone and install').join('\n');

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
