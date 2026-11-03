import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { SECRETS } from '../../infra/config';
import { CENSOR, createLogger, MIN_SCRUBBED_LENGTH, REDACTED_KEYS, redactLine, SCRUBBED_SECRETS, scrubValues } from '../../src/server/logger';
import { repoRoot } from '../support/repo-file';
import { captureLogger } from './capture';

const captureEvents = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

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

  /**
   * Each key as written, in lower case, in upper case, in the canonical case of an HTTP header
   * (`Set-Cookie`, `X-Api-Key`, `ApiKey`) and in alternating case. Header names are
   * case-insensitive, and a plain-object `headers` map keeps whatever case its author wrote.
   */
  const spellingsOf = (key: string) => [
    ...new Set([
      key,
      key.toLowerCase(),
      key.toUpperCase(),
      key.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-'),
      [...key].map((char, index) => (index % 2 ? char.toUpperCase() : char.toLowerCase())).join(''),
    ]),
  ];

  it('[OPS-2] logs none of them in any letter case, at the top level, nested, in headers or inside an error', () => {
    const { log, lines } = captureLogger();
    const spellings = REDACTED_KEYS.flatMap(spellingsOf);
    for (const key of spellings) {
      const value = secretFor(key);
      log.info({ [key]: value }, 'top level');
      log.info({ request: { [key]: value } }, 'one level down');
      log.info({ request: { headers: { [key]: value } } }, 'in headers');
      log.info({ a: { b: { c: { d: { [key]: value } } } } }, 'four levels down');
      const error = Object.assign(new Error('the request failed'), { config: { headers: { [key]: value } }, [key]: value });
      log.error({ err: error }, 'inside an error');
    }
    expect(lines).toHaveLength(spellings.length * 5);
    const output = lines.join('');
    for (const key of spellings) expect(output, key).not.toContain(secretFor(key));
    expect(output.split(CENSOR).length - 1).toBe(spellings.length * 6);
  });

  it('[OPS-2] logs none of them from an HTTP client error that carries its request config', () => {
    const { log, lines } = captureLogger();
    const error = Object.assign(new Error('Request failed with status code 429'), {
      config: { url: 'https://api.example.test/v3/', headers: { Authorization: 'key made-up-rebrickable-key-0f3a9c', Accept: 'application/json' } },
      response: { status: 429, headers: { 'Set-Cookie': 'made-up-cookie-0f3a9c', 'Retry-After': '5' } },
    });
    log.error(error);
    log.error({ err: error, businessEvent: 'example.request.failed' }, 'the client failed');
    const output = lines.join('');
    expect(output).not.toContain('made-up-rebrickable-key-0f3a9c');
    expect(output).not.toContain('made-up-cookie-0f3a9c');
    const [event] = captureEvents(lines);
    expect(event).toMatchObject({
      err: { message: 'Request failed with status code 429', config: { headers: { Authorization: CENSOR, Accept: 'application/json' } }, response: { headers: { 'Set-Cookie': CENSOR, 'Retry-After': '5' } } },
    });
  });

  it('[OPS-2] logs none of them however deep they sit or from a child logger\'s bindings', () => {
    const { log, lines } = captureLogger();
    log.info({ a: { b: { c: { d: { e: { f: { headers: { Cookie: 'made-up-deep-cookie-0f3a9c' } } } } } } } }, 'deep');
    log.child({ headers: { 'X-API-Key': 'made-up-bound-key-0f3a9c' } }).info('bound');
    const output = lines.join('');
    expect(output).not.toContain('made-up-deep-cookie-0f3a9c');
    expect(output).not.toContain('made-up-bound-key-0f3a9c');
    expect(output.split(CENSOR).length - 1).toBe(2);
  });

  it('[OPS-2] drops a line it cannot parse rather than write it unredacted', () => {
    const line = redactLine('{"level":"info","authorization":"made-up-unparsed-0f3a9c"\n');
    expect(line).not.toContain('made-up-unparsed-0f3a9c');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ level: 'error' });
  });

  it('writes a line with nothing to redact exactly as pino made it', () => {
    const line = '{"level":"info","time":"2026-11-01T00:00:00.000Z","big":12345678901234567890,"msg":"kept"}\n';
    expect(redactLine(line)).toBe(line);
  });

  it('[OPS-2] keeps the fields that are not secrets', () => {
    const { log, events } = captureLogger();
    log.info({ businessEvent: 'example.event.happened', path: '/health/live', method: 'GET' }, 'kept');
    expect(events()[0]).toMatchObject({ businessEvent: 'example.event.happened', path: '/health/live', method: 'GET' });
  });
});

describe('value scrubbing, the second layer', () => {
  // Made-up values in the shapes the real ones have: `openssl rand -base64 48` and a scrypt hash.
  const sessionSecret = 'mAdE+uP/sEsSiOn+sEcReT/0f3a9cQx7Lk2Vb9Nw4Rt6Yh8Ju1Ik3Ol5Pz0Xc2Vb4Nm6Qw==';
  const passwordHash = 'scrypt:ln=17,r=8,p=1:bWFkZS11cC1zYWx0LTBm:bWFkZS11cC1rZXktMGYzYTljLXRoaXJ0eS10d28tYnl0ZXM';

  function scrubbingLogger() {
    const lines: string[] = [];
    const log = createLogger({ write: (line: string) => void lines.push(line) }, { secretValues: [sessionSecret, passwordHash] });
    return { log, lines };
  }

  it('[OPS-2] scrubs the session secret and the admin password hash from every line by value, in a message string included', () => {
    const { log, lines } = scrubbingLogger();
    for (const value of [sessionSecret, passwordHash]) {
      log.info(`the value is ${value} in a message`);
      log.info({ note: `inside a field: ${value}`, nested: { deeper: [value] } }, 'in fields');
      log.error({ err: new Error(`an error that quotes ${value}`) }, 'in an error');
      log.child({ bound: value }).warn('in a binding');
      log.info({ quoted: `"${value}"` }, 'in a JSON-escaped form');
    }
    const output = lines.join('');
    expect(output).not.toContain(sessionSecret);
    expect(output).not.toContain(passwordHash);
    expect(output).toContain(CENSOR);
    // Every line is still one JSON line.
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toContain(`the value is ${CENSOR} in a message`);
  });

  it('[OPS-2] covers the secrets the server function is linked to, and reads their values from the links by default', () => {
    expect([...SCRUBBED_SECRETS].sort()).toEqual([
      'AdminPasswordHash',
      'BrickLinkConsumerKey',
      'BrickLinkConsumerSecret',
      'BrickLinkTokenSecret',
      'BrickLinkTokenValue',
      'RebrickableApiKey',
      'SessionSecret',
    ]);
    expect(readFileSync(join(repoRoot, 'src/server/logger.ts'), 'utf8')).toMatch(/options\.secretValues \?\? linkedSecretValues\(\)/);
  });

  it('[OPS-2] leaves a line alone when a value is too short to be a real secret', () => {
    expect(scrubValues('{"msg":"a b c"}\n', ['a'])).toBe('{"msg":"a b c"}\n');
    expect(MIN_SCRUBBED_LENGTH).toBeGreaterThanOrEqual(8);
  });
});
