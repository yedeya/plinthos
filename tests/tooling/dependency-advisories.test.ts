import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../support/repo-file';

interface LockedPackage {
  version?: string;
}

const lockfile = JSON.parse(readRepoFile('package-lock.json')) as { packages: Record<string, LockedPackage> };

// The high advisories `npm audit` has reported against the lockfile, each resolved rather than
// accepted. docs/dependency-audit.md records why each one was reachable and how it was resolved.
const RESOLVED_HIGH_ADVISORIES = [
  // glob's CLI runs `-c/--cmd` with shell:true. @node-minify/core, which @opennextjs/aws's build
  // brings in, pins glob 10.3.3; package.json's `overrides` lift it to 10.5.0.
  { id: 'GHSA-5j98-mcp5-4vw2', name: 'glob', introduced: '10.2.0', fixed: '10.5.0' },
];

/** Compares two plain `major.minor.patch` versions, ignoring any prerelease or build suffix. */
function compareVersions(left: string, right: string): number {
  const parts = (version: string) => (version.split(/[-+]/)[0] ?? '').split('.').map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Every version of the named package the lockfile installs, keyed by where it installs it. */
function lockedVersions(name: string): [string, string][] {
  return Object.entries(lockfile.packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, entry]) => [path, entry.version ?? '']);
}

describe('the lockfile and the high npm advisories', () => {
  it.each(RESOLVED_HIGH_ADVISORIES)('installs no $name in the range $id affects', ({ name, introduced, fixed }) => {
    const versions = lockedVersions(name);
    expect(versions.length, `the lockfile installs no ${name}: drop the entry if it is gone`).toBeGreaterThan(0);
    const affected = versions.filter(
      ([, version]) => compareVersions(version, introduced) >= 0 && compareVersions(version, fixed) < 0,
    );
    expect(affected).toEqual([]);
  });
});
