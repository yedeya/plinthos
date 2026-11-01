import pino from 'pino';
import { vi } from 'vitest';
import { createLogger, logger, type Logger } from '../../src/server/logger';

/** The real logger, writing into memory: its raw lines, and each parsed. */
export function captureLogger(): { log: Logger; lines: string[]; events: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const log = createLogger({ write: (line: string) => void lines.push(line) });
  return { log, lines, events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/**
 * The one logger production code writes through, its lines kept in memory instead of reaching
 * standard output: the lines exactly as they leave pino, redacted. Restore with
 * `vi.restoreAllMocks()`.
 */
export function captureSharedLogger(): { lines: string[]; events: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => boolean }>)[pino.symbols.streamSym];
  if (stream === undefined) throw new Error('the shared logger has no destination stream to capture');
  vi.spyOn(stream, 'write').mockImplementation((line: string) => {
    lines.push(line);
    return true;
  });
  return { lines, events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}
