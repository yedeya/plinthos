import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_NOTIFICATIONS } from '../../infra/budget';
import { readRepoFile, repoRoot } from '../support/repo-file';
import { installFakeSst, type FakeSst } from './fake-sst';
import { runStack } from './harness';

let fake: FakeSst;
beforeEach(() => {
  fake = installFakeSst();
});
afterEach(() => fake.uninstall());

const document = readRepoFile('docs/observability.md');

/** The rows of the table between one pair of K-LAYOUT-5 anchors, as arrays of cells. */
function table(anchor: string): string[][] {
  const open = `<!-- ${anchor} -->`;
  const close = `<!-- /${anchor} -->`;
  for (const marker of [open, close]) {
    const count = document.split('\n').filter((line) => line.trim() === marker).length;
    if (count !== 1) throw new Error(`docs/observability.md has ${count} "${marker}" lines, not exactly one`);
  }
  const body = document.slice(document.indexOf(open) + open.length, document.indexOf(close));
  return body
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2) // the header and its separator
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

/** The signal name a row leads with, in backticks. */
function signal(row: string[]): string {
  const match = /^`([a-z0-9_]+(?:\.[a-z0-9_]+)+)`$/.exec(row[0] ?? '');
  if (match === null) throw new Error(`a row does not lead with a dot-separated lowercase signal name: ${row.join(' | ')}`);
  return match[1] ?? '';
}

/** Every `businessEvent` name the code under src/ emits, as a literal. */
function emittedBusinessEvents(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry)) files.push(path);
    }
  };
  walk(join(repoRoot, 'src'));
  return files.flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const names = [...source.matchAll(/businessEvent\s*:\s*(['"`])([^'"`]+)\1/g)].map((match) => match[2] ?? '');
    const unresolved = (source.match(/businessEvent\s*:/g) ?? []).length - names.length;
    if (unresolved > 0) throw new Error(`${relative(repoRoot, path)} emits a businessEvent this guard cannot read as a literal`);
    return names;
  });
}

describe('docs/observability.md', () => {
  it('[OPS-3] holds the three tables between their K-LAYOUT-5 anchors, each once', () => {
    for (const anchor of ['paging-clauses:table', 'not-paged-table', 'hand-created:table']) {
      expect(() => table(anchor), anchor).not.toThrow();
      expect(table(anchor).length, anchor).toBeGreaterThan(0);
    }
  });

  it('[OPS-3] every budget notification and every alarm the stack defines is a paged row, and every paged row is one of them', () => {
    runStack(fake);
    const budgets = fake.ofType('aws:budgets/budget:Budget');
    expect(budgets).toHaveLength(1);
    const notifications = budgets[0]?.args.notifications as { notificationType: string; threshold: number }[];
    // Each notification the stack defines is one of the named signals, so the paged table can name it.
    expect(notifications.map(({ notificationType, threshold }) => ({ notificationType, threshold }))).toEqual(
      BUDGET_NOTIFICATIONS.map(({ notificationType, threshold }) => ({ notificationType, threshold })),
    );
    const alarms = fake.ofType('aws:cloudwatch/metricAlarm:MetricAlarm').map((alarm) => String(alarm.args.name ?? alarm.name));
    const defined = [...BUDGET_NOTIFICATIONS.map((notification) => notification.signal), ...alarms].sort();
    expect(table('paging-clauses:table').map(signal).sort()).toEqual(defined);
  });

  it('[OPS-3] every paged row says what it means, its threshold and what a person does', () => {
    for (const row of table('paging-clauses:table')) {
      expect(row, row[0]).toHaveLength(4);
      for (const cell of row) expect(cell, row[0]).not.toBe('');
    }
  });

  it('[OPS-3] every businessEvent the code emits is in exactly one of the paged and the not-paged tables', () => {
    const paged = table('paging-clauses:table').map(signal);
    const notPaged = table('not-paged-table').map(signal);
    expect(paged.filter((name) => notPaged.includes(name)), 'in both tables').toEqual([]);
    for (const event of emittedBusinessEvents()) {
      expect(event, 'dot-separated lowercase').toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      expect([...paged, ...notPaged], event).toContain(event);
    }
  });

  it('[OPS-3] every not-paged row says why, and what would change the answer', () => {
    for (const row of table('not-paged-table')) {
      signal(row);
      expect(row, row[0]).toHaveLength(3);
      for (const cell of row) expect(cell, row[0]).not.toBe('');
    }
  });

  it('[OPS-3] every hand-created row is dated or tracked, and says how far it was verified (K-OBS-8)', () => {
    for (const [resource, state, verified] of table('hand-created:table')) {
      expect(resource, 'resource').toBeTruthy();
      expect(state, resource).toMatch(/^(?:created \d{4}-\d{2}-\d{2}(?: \(#\d+\))?|not yet created \(#\d+\))$/);
      expect(verified, resource).toMatch(/^(?:configuration|delivery|no)$/);
    }
  });
});
