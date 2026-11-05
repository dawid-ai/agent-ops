import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { OpsError } from './ids.js';

const STALE_MS = 30_000;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(path: string): boolean {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const pid = Number(readFileSync(path, 'utf8').split(' ')[0]);
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
    return age > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Windows reports EPERM (and sometimes EBUSY) while another process deletes the lock file, which
 * stays "delete pending" until its last handle closes, or while a scanner holds it open. Those
 * clear in milliseconds, so they count as a busy lock there. On other platforms EPERM is a real
 * permission error and fails at once.
 */
function transientOnWindows(code: string | undefined, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && (code === 'EPERM' || code === 'EBUSY');
}

/**
 * Runs `fn` while holding an exclusive lock file. The lock is a file created with `wx`; a lock
 * whose process is gone, or that is older than 30 s, is taken over.
 */
export function withLock<T>(
  path: string,
  fn: () => T,
  timeoutMs = 15_000,
  platform: NodeJS.Platform = process.platform,
): T {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  let wait = 5;
  while (fd === undefined) {
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && !transientOnWindows(code, platform)) throw err;
      // The Windows EPERM or EBUSY from this attempt, from opening or from removing a stale lock.
      let transientErr: unknown = code === 'EEXIST' ? undefined : err;
      if (code === 'EEXIST' && isStale(path)) {
        try {
          rmSync(path, { force: true });
          continue;
        } catch (rmErr) {
          if (!transientOnWindows((rmErr as NodeJS.ErrnoException).code, platform)) throw rmErr;
          transientErr = rmErr;
        }
      }
      if (Date.now() > deadline) {
        // A Windows EPERM that never clears is a real access error; surface it as such.
        if (transientErr !== undefined) throw transientErr;
        throw new OpsError(`timed out waiting for lock ${path}`);
      }
      sleep(wait);
      wait = Math.min(wait * 2, 100);
    }
  }
  try {
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}
