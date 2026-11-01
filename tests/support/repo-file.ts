import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Reads a file of the repository by its repository-relative path.
 *
 * The review lane restores the pipeline's own files (every markdown file directly inside
 * `docs/qa/`, the project-setup hook) from the default branch and parks the pull request's
 * copies under `.qa-pr/<same path>`. A test that reads one of them reads the parked copy when
 * there is one, so it judges the pull request's version rather than `main`'s.
 */
export function readRepoFile(path: string): string {
  const parked = join(repoRoot, '.qa-pr', path);
  return readFileSync(existsSync(parked) ? parked : join(repoRoot, path), 'utf8');
}

/** The lines of one `## ` section of a markdown document, outside fenced blocks. */
export function markdownSection(markdown: string, heading: string): string[] {
  const lines: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      inSection = line === `## ${heading}`;
      continue;
    }
    if (inSection) lines.push(line);
  }
  return lines;
}
