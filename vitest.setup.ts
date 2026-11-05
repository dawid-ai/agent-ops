import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

// Tests never see the real user config or opsd state: anything that falls back to the process
// environment lands in a scratch folder instead of the developer's own files.
const scratch = mkdtempSync(join(tmpdir(), 'ops-test-env-'));
process.env.OPS_CONFIG = join(scratch, 'config.yml');
process.env.OPS_STATE_DIR = join(scratch, 'opsd');

// The runner moves from test to test on microtasks only, so a file of synchronous tests (git via
// execFileSync) never lets the worker read its IPC replies. Once such a file runs past 60 s, the
// worker's pending `onTaskUpdate` call times out even though the reply is already waiting, and the
// run exits non-zero. Two setImmediate turns guarantee one poll phase between tests, which delivers
// those replies. The 60 s RPC timeout is fixed inside vitest, so the config cannot raise it.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});
