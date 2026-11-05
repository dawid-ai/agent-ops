import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
const mainJs = join(repoTop, 'packages', 'cli', 'dist', 'main.js');
let cwd = '';

beforeAll(() => {
  // Build incrementally, so the test never runs a stale main.js.
  execFileSync(
    process.execPath,
    [join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/cli'],
    { cwd: repoTop, windowsHide: true },
  );
  cwd = mkdtempSync(join(tmpdir(), 'ops-main-'));
}, 120_000);

afterAll(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('ops main', () => {
  it('exits cleanly when the reader closes stdout early', async () => {
    const env = { ...process.env, OPS_CONFIG: join(cwd, 'none.yml'), OPS_AGENT: 'human:dawid' };
    const { code, err } = await new Promise<{ code: number | null; err: string }>(
      (resolve, reject) => {
        const p = spawn(process.execPath, [mainJs, 'help'], { cwd, env, windowsHide: true });
        // Close the read end before ops writes anything, like `ops help | head -0`.
        p.stdout.destroy();
        let err = '';
        p.stderr.on('data', (c: Buffer) => (err += c.toString()));
        p.on('error', reject);
        p.on('close', (code) => resolve({ code, err }));
      },
    );
    expect(err).not.toMatch(/EPIPE|Unhandled/);
    expect(code).toBe(0);
  });
});
