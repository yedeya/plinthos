import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { SECRETS } from '../../infra/config';
import { CENSOR, REDACTED_KEYS } from '../../src/server/logger';
import { repoRoot } from '../support/repo-file';
import { captureLogger } from './capture';

/** Every source file under src/, as repository-relative paths. */
function sourceFiles(dir = join(repoRoot, 'src')): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry) ? [relative(repoRoot, path)] : [];
  });
}

describe('the logger', () => {
  it('[OPS-1] writes each event as one JSON line, with its level, time, message and businessEvent', () => {
    const { log, lines, events } = captureLogger();
    log.info({ businessEvent: 'example.event.happened', count: 2 }, 'first');
    log.error({ businessEvent: 'example.event.failed', detail: 'a\nmultiline\nvalue' }, 'second');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
    }
    const [first, second] = events();
    expect(first).toMatchObject({ level: 'info', msg: 'first', businessEvent: 'example.event.happened', count: 2 });
    expect(second).toMatchObject({ level: 'error', msg: 'second', businessEvent: 'example.event.failed' });
    expect(new Date(String(first?.time)).toISOString()).toBe(first?.time);
    // No pid or hostname: the event is what was logged and nothing more.
    expect(Object.keys(first ?? {}).sort()).toEqual(['businessEvent', 'count', 'level', 'msg', 'time']);
  });

  it('[OPS-1] is the only module under src/ that imports pino', () => {
    const importers = sourceFiles().filter((path) =>
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]pino(?:\/[^'"]*)?['"]/.test(readFileSync(join(repoRoot, path), 'utf8')),
    );
    expect(importers).toEqual(['src/server/logger.ts']);
  });

  it('[OPS-1] lint refuses a console call in server code', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    for (const file of ['src/server/example.ts', 'src/app/example/route.ts', 'src/instrumentation.ts']) {
      const [result] = await eslint.lintText("console.log('logged around the logger');\n", { filePath: join(repoRoot, file) });
      expect(result?.messages.map((message) => message.ruleId), file).toContain('no-console');
    }
  });
});

describe('redaction', () => {
  // A made-up value for each key: the test fails if any of them reaches a line.
  const secretFor = (key: string) => `made-up-${key}-value-0f3a9c`;

  it('[OPS-2] covers every SST secret infra/config.ts declares, under its camel-case name', () => {
    for (const { name } of SECRETS) {
      expect(REDACTED_KEYS, name).toContain(name.charAt(0).toLowerCase() + name.slice(1));
    }
  });

  it('[OPS-2] covers session ids, cookies, passwords, password hashes and secrets', () => {
    for (const key of ['sessionId', 'session', 'cookie', 'set-cookie', 'authorization', 'password', 'passwordHash', 'adminPasswordHash', 'sessionSecret', 'secret', 'token']) {
      expect(REDACTED_KEYS, key).toContain(key);
    }
  });

  it('[OPS-2] logs none of them, at the top level, nested, in headers or inside an error', () => {
    const { log, lines } = captureLogger();
    for (const key of REDACTED_KEYS) {
      const value = secretFor(key);
      log.info({ [key]: value }, 'top level');
      log.info({ request: { [key]: value } }, 'one level down');
      log.info({ request: { headers: { [key]: value } } }, 'in headers');
      log.info({ a: { b: { c: { d: { [key]: value } } } } }, 'four levels down');
      const error = Object.assign(new Error('the request failed'), { config: { headers: { [key]: value } }, [key]: value });
      log.error({ err: error }, 'inside an error');
    }
    expect(lines).toHaveLength(REDACTED_KEYS.length * 5);
    const output = lines.join('');
    for (const key of REDACTED_KEYS) expect(output, key).not.toContain(secretFor(key));
    expect(output.split(CENSOR).length - 1).toBe(REDACTED_KEYS.length * 6);
  });

  it('[OPS-2] keeps the fields that are not secrets', () => {
    const { log, events } = captureLogger();
    log.info({ businessEvent: 'example.event.happened', path: '/health/live', method: 'GET' }, 'kept');
    expect(events()[0]).toMatchObject({ businessEvent: 'example.event.happened', path: '/health/live', method: 'GET' });
  });
});
