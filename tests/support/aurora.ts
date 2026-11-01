import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './repo-file';

/**
 * The PostgreSQL major version of the Aurora engine the deployment runs, which the test
 * database must match ([DEV-4]).
 *
 * Read from the `sst.aws.Aurora` definition in `sst.config.ts` or under `infra/`, whose
 * `version` must be pinned explicitly so this can compare. Until the stack defines a cluster
 * (#14), the walking-skeleton brief's choice stands: 16 (`docs/projects/6.md`, Issue A). Any
 * mention of `sst.aws.Aurora` or `aws.rds.Cluster` ends that default, so a definition this can't read
 * fails rather than falling back.
 */
export function auroraPostgresMajor(): number {
  if (!existsSync(join(repoRoot, 'sst.config.ts'))) return 16;
  const sources = [join(repoRoot, 'sst.config.ts'), ...typescriptFiles(join(repoRoot, 'infra'))];
  if (!sources.some((file) => /\bsst\.aws\.Aurora\b|\baws\.rds\.Cluster\b/.test(readFileSync(file, 'utf8')))) return 16;
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    const start = text.search(/new\s+sst\.aws\.Aurora\s*\(/);
    if (start === -1) continue;
    // The component's arguments: enough of what follows the constructor to hold them.
    const definition = text.slice(start, start + 2000);
    const version = /\bversion:\s*["'](\d+)\./.exec(definition)?.[1];
    if (version === undefined) {
      throw new Error(`${file} defines the Aurora cluster without an explicit \`version\`; pin it so the test database can match its major version`);
    }
    return Number(version);
  }
  throw new Error('sst.config.ts exists but no `new sst.aws.Aurora(...)` definition was found in it or under infra/; update tests/support/aurora.ts to find the engine version');
}

function typescriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}
