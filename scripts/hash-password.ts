/**
 * Prints the scrypt hash of a password, for the `AdminPasswordHash` SST secret ([AUTH-2],
 * docs/deploy.md, step 4). It reaches nothing: no AWS, no database, no network.
 *
 *     npx sst secret set AdminPasswordHash "$(npm run --silent auth:hash-password)" --stage production
 *
 * At a terminal it asks for the password twice on standard error, without echoing it. Otherwise
 * it reads the password from the first line of standard input. Only the hash goes to standard
 * output, so the command above captures nothing else. The password is never printed or written
 * anywhere.
 */
import { stderr, stdin, stdout } from 'node:process';
import { hashPassword } from '../src/server/auth/password';

/** The shortest password accepted. */
export const MIN_PASSWORD_LENGTH = 12;

/** Reads one line from a terminal with echo off. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return done();
        if (char === '\u0003') return done(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string> {
  let input = '';
  for await (const chunk of stdin) input += String(chunk);
  return input.split(/\r?\n/)[0] ?? '';
}

async function main(): Promise<void> {
  let password: string;
  if (stdin.isTTY) {
    password = await readHidden('Password: ');
    const again = await readHidden('The same password again: ');
    if (again !== password) throw new Error('The two passwords differ: nothing was printed.');
  } else {
    password = await readPiped();
  }
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The password is shorter than ${MIN_PASSWORD_LENGTH} characters: nothing was printed.`);
  }
  stdout.write(`${await hashPassword(password)}\n`);
}

main().catch((error: unknown) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
