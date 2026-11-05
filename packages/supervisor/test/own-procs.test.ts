import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isAlive, type KillResult, type ProcLister } from '../src/index.js';
import { killOwn } from './own-procs.js';

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Runs `body` with a live child this test spawned, and stops the child through its own handle. */
async function withChild(body: (child: ChildProcess) => Promise<void>): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await until(() => isAlive(child.pid!));
    await body(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/** A lister that sees `pid` as created at 0 and answers every kill with `result`. */
function fakeLister(pid: number, precise: boolean, result: KillResult) {
  const kills: number[] = [];
  const lister: ProcLister = {
    precise,
    clockSlack: 0,
    list: () => Promise.resolve([{ pid, ppid: 0, name: 'node', cmd: 'node', start: 0 }]),
    kill: (targets) => {
      kills.push(...targets.map((t) => t.pid));
      return Promise.resolve(new Map(targets.map((t) => [t.pid, result])));
    },
    close: () => {},
  };
  return { lister, kills };
}

const precise = process.platform === 'win32' || process.platform === 'linux';

describe('killOwn (AO-0145)', () => {
  it.skipIf(!precise)(
    'leaves a PID whose process started after the test last saw its own, and stops its own',
    () =>
      withChild(async (child) => {
        // A time before the child existed stands for a test whose own process held this PID earlier.
        expect(await killOwn(child.pid!, Date.now() - 60_000)).toBe(false);
        expect(isAlive(child.pid!)).toBe(true);
        expect(await killOwn(child.pid!, Date.now())).toBe(true);
        await until(() => child.exitCode !== null || child.signalCode !== null);
      }),
    60_000,
  );

  it('leaves the process running when the identity-checked kill reports an error', () =>
    withChild(async (child) => {
      const { lister, kills } = fakeLister(child.pid!, true, 'error');
      expect(await killOwn(child.pid!, Date.now(), lister)).toBe(false);
      expect(kills).toEqual([child.pid]);
      expect(isAlive(child.pid!)).toBe(true);
    }));

  it('kills nothing with a lister that cannot tell a reused PID apart', () =>
    withChild(async (child) => {
      const { lister, kills } = fakeLister(child.pid!, false, 'error');
      expect(await killOwn(child.pid!, Date.now(), lister)).toBe(false);
      expect(kills).toEqual([]);
      expect(isAlive(child.pid!)).toBe(true);
    }));
});
