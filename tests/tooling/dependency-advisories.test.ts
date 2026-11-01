import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../support/repo-file';

interface LockedPackage {
  version?: string;
}

const lockfile = JSON.parse(readRepoFile('package-lock.json')) as { packages: Record<string, LockedPackage> };

// The high advisories `npm audit` has reported against the lockfile, each resolved rather than
// accepted. docs/dependency-audit.md records why each one was reachable and how it was resolved.
// `ranges` lists every range the advisory affects, each `introduced` inclusive and `fixed` exclusive.
const RESOLVED_HIGH_ADVISORIES = [
  // glob's CLI runs `-c/--cmd` with shell:true. @node-minify/core, which @opennextjs/aws's build
  // brings in, pins glob 10.3.3; package.json's `overrides` lift it to 10.5.0.
  {
    id: 'GHSA-5j98-mcp5-4vw2',
    name: 'glob',
    ranges: [
      { introduced: '10.2.0', fixed: '10.5.0' },
      { introduced: '11.0.0', fixed: '11.1.0' },
    ],
  },
];

type Advisory = (typeof RESOLVED_HIGH_ADVISORIES)[number];

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

/** The installed versions that fall in any range the advisory affects. */
function affectedVersions({ ranges }: Advisory, versions: [string, string][]): [string, string][] {
  return versions.filter(([, version]) =>
    ranges.some(
      ({ introduced, fixed }) => compareVersions(version, introduced) >= 0 && compareVersions(version, fixed) < 0,
    ),
  );
}

describe('the lockfile and the high npm advisories', () => {
  it.each(RESOLVED_HIGH_ADVISORIES)('installs no $name in the range $id affects', (advisory) => {
    const versions = lockedVersions(advisory.name);
    const gone = `the lockfile installs no ${advisory.name}: drop the entry if it is gone`;
    expect(versions.length, gone).toBeGreaterThan(0);
    expect(affectedVersions(advisory, versions)).toEqual([]);
  });

  it('reports a glob in either range GHSA-5j98-mcp5-4vw2 affects, and none outside them', () => {
    const advisory = RESOLVED_HIGH_ADVISORIES.find(({ id }) => id === 'GHSA-5j98-mcp5-4vw2');
    if (advisory === undefined) throw new Error('GHSA-5j98-mcp5-4vw2 is not in RESOLVED_HIGH_ADVISORIES');
    const versions = ['10.1.0', '10.2.0', '10.3.3', '10.4.5', '10.5.0', '11.0.0', '11.0.3', '11.1.0', '12.0.0'];
    const fixture = versions.map((version): [string, string] => [`node_modules/glob-${version}`, version]);
    expect(affectedVersions(advisory, fixture).map(([, version]) => version)).toEqual([
      '10.2.0',
      '10.3.3',
      '10.4.5',
      '11.0.0',
      '11.0.3',
    ]);
  });
});
