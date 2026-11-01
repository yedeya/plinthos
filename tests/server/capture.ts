import { createLogger, type Logger } from '../../src/server/logger';

/** The real logger, writing into memory: its raw lines, and each parsed. */
export function captureLogger(): { log: Logger; lines: string[]; events: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const log = createLogger({ write: (line: string) => void lines.push(line) });
  return { log, lines, events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}
