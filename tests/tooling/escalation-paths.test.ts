import { describe, expect, it } from 'vitest';
import { markdownSection, readRepoFile } from '../support/repo-file';

interface Entry {
  pattern: string;
  category: string;
}

// The walking-skeleton brief's decision 7, with the Owner's addition on #10 of the sync and
// photo directories. Each is a regular expression over repository-relative paths, with its
// category from Kanon's closed list (K-LAYOUT-8), and a path it must and must not match.
const EXPECTED = [
  { pattern: '^sst\\.config\\.ts$', category: 'infra', matches: 'sst.config.ts', misses: 'sst.config.ts.bak' },
  { pattern: '^infra/', category: 'infra', matches: 'infra/database.ts', misses: 'src/infra/database.ts' },
  { pattern: '^drizzle/', category: 'migrations', matches: 'drizzle/0000_init.sql', misses: 'src/drizzle/x.ts' },
  { pattern: '^src/db/schema/', category: 'schema', matches: 'src/db/schema/photos.ts', misses: 'src/db/client.ts' },
  { pattern: '^src/server/auth/', category: 'auth', matches: 'src/server/auth/session.ts', misses: 'tests/server/auth/session.test.ts' },
  { pattern: '^src/server/publish/projection', category: 'other', matches: 'src/server/publish/projection.ts', misses: 'src/server/publish/upload.ts' },
  { pattern: '^src/server/sync/', category: 'other', matches: 'src/server/sync/apply.ts', misses: 'src/app/sync/queue.ts' },
  { pattern: '^src/server/photos/', category: 'other', matches: 'src/server/photos/reencode.ts', misses: 'src/app/photos/upload.ts' },
];

const CATEGORIES = ['pipeline', 'playbooks', 'infra', 'migrations', 'schema', 'payments', 'auth', 'other'];

/** The `## Escalation paths` bullets: a pattern in backticks, its category, an em dash, a reason. */
function escalationPaths(): Entry[] {
  return markdownSection(readRepoFile('docs/qa/escalation-paths.md'), 'Escalation paths')
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const match = /^- `([^`]+)`(?: `([^`]+)`)? — \S/.exec(line);
      if (match === null) throw new Error(`not an escalation-path entry: ${line}`);
      return { pattern: match[1] ?? '', category: match[2] ?? 'other' };
    });
}

describe('docs/qa/escalation-paths.md', () => {
  it('[DEV-6] declares the infrastructure, schema, migrations, auth, public projection, sync and photo paths, each with its category', () => {
    expect(escalationPaths()).toEqual(EXPECTED.map(({ pattern, category }) => ({ pattern, category })));
    for (const { category } of escalationPaths()) expect(CATEGORIES).toContain(category);
  });

  it('[DEV-6] each escalation path matches the code it holds and not its neighbours', () => {
    for (const { pattern, matches, misses } of EXPECTED) {
      const regex = new RegExp(pattern);
      expect(regex.test(matches), `${pattern} should match ${matches}`).toBe(true);
      expect(regex.test(misses), `${pattern} should not match ${misses}`).toBe(false);
    }
  });
});
