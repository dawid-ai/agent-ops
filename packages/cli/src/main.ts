#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from './cli.js';

// A reader that closes early (`ops show ID | head -4`) breaks the pipe. Drop the rest of the
// output and let the command finish, so its side effects and exit code stay intact.
let stdoutClosed = false;
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e;
  stdoutClosed = true;
});

const result = run(process.argv.slice(2), {
  out: (line) => {
    if (!stdoutClosed) process.stdout.write(`${line}\n`);
  },
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
  readStdin: () => readFileSync(0, 'utf8'),
});
process.exitCode = typeof result === 'number' ? result : await result;
