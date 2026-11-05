import { describe, expect, it } from 'vitest';
import type { ProcInfo, ProcLedger } from '../src/index.js';
import {
  parseLinuxStat,
  parsePs,
  parseWindows,
  survivors,
  systemLister,
  track,
  viewLedger,
} from '../src/index.js';

// Times are whole seconds apart, so the rules hold with the 1 s slack Unix uses for `ps`.
const T0 = Date.parse('2026-11-01T12:00:00Z');
const S = 1000;
const p = (pid: number, ppid: number, start: number, pgid?: number): ProcInfo => ({
  pid,
  ppid,
  pgid,
  name: `p${pid}`,
  cmd: `p${pid}`,
  start,
});
const ledger = (): ProcLedger => ({ run: 'R1', root_pid: 100, root_start: T0, entries: [] });
const pids = (l: ProcLedger) => l.entries.map((e) => [e.pid, e.unsure ? 'unsure' : 'yes']);

describe('process ledger', () => {
  it('records the root and everything below it, and nothing else', () => {
    const l = ledger();
    const snap = [p(100, 1, T0), p(101, 100, T0 + S), p(102, 101, T0 + 2 * S), p(200, 1, T0 + S)];
    expect(track(l, snap, T0 + 10 * S)).toBe(3);
    expect(pids(l)).toEqual([
      [100, 'yes'],
      [101, 'yes'],
      [102, 'yes'],
    ]);
    expect(track(l, snap, T0 + 20 * S)).toBe(0);
  });

  it('takes the root only with the creation time from the run record', () => {
    const reused = ledger();
    // The run's process exited before the first look and PID 100 went to another process 10 s
    // later; the old 60 s window took it.
    expect(track(reused, [p(100, 1, T0 + 10 * S), p(101, 100, T0 + 11 * S)], T0 + 12 * S)).toBe(0);
    expect(reused.entries).toEqual([]);
    // Reuse within the same second: only an exact creation time counts.
    const sameSecond = ledger();
    expect(track(sameSecond, [p(100, 1, T0 + 500)], T0 + S)).toBe(0);
    const unknown = { ...ledger(), root_start: null };
    expect(track(unknown, [p(100, 1, T0)], T0 + S)).toBe(0);
  });

  it('never records its own helper', () => {
    const l = ledger();
    expect(track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 2 * S, [101])).toBe(1);
    expect(pids(l)).toEqual([[100, 'yes']]);
  });

  it('keeps a child that started while its exited parent was still seen alive', () => {
    const l = ledger();
    // 102 already ran at the look at +10 s, but its parent 101 only showed up then too.
    track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 10 * S);
    track(l, [p(100, 1, T0), p(102, 101, T0 + 5 * S)], T0 + 15 * S);
    expect(pids(l)).toContainEqual([102, 'yes']);
  });

  it('marks a child of an exited parent as unsure when the parent PID could have been reused', () => {
    const l = ledger();
    track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 10 * S);
    // 101 exited after +10 s; 102 started at +12 s, before 101 was seen gone at +15 s. Nothing
    // holds PID 101 now, so 102 is 101's orphan or the child of a process that reused the PID.
    track(l, [p(100, 1, T0), p(102, 101, T0 + 12 * S)], T0 + 15 * S);
    expect(pids(l)).toContainEqual([102, 'unsure']);
    const snap = [p(100, 1, T0), p(102, 101, T0 + 12 * S)];
    expect(survivors(l, snap).map((e) => e.pid)).toEqual([100]);
    expect(survivors(l, snap, { unsure: true }).map((e) => e.pid)).toEqual([100, 102]);
    expect(viewLedger(l, snap).find((v) => v.pid === 102)).toMatchObject({ alive: true });
  });

  it('ignores the child of a process that reused a recorded parent PID', () => {
    const l = ledger();
    track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 10 * S);
    // 101 exited; an unrelated process took PID 101 at +11 s and started 102 at +12 s, all
    // before the next look.
    const snap = [p(100, 1, T0), p(101, 1, T0 + 11 * S), p(102, 101, T0 + 12 * S)];
    expect(track(l, snap, T0 + 15 * S)).toBe(0);
    expect(pids(l)).toEqual([
      [100, 'yes'],
      [101, 'yes'],
    ]);
    // A child started after the parent was seen gone is never its.
    expect(track(l, [p(100, 1, T0), p(103, 101, T0 + 20 * S)], T0 + 25 * S)).toBe(0);
  });

  it('allows for creation times that may be off the wall clock', () => {
    const l = ledger();
    track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 10 * S, [], 1000);
    // 102 started 0.5 s before the look that last saw 101; with Linux's 1 s slack it may have
    // started after it.
    track(l, [p(100, 1, T0), p(102, 101, T0 + 9500)], T0 + 15 * S, [], 1000);
    expect(pids(l)).toContainEqual([102, 'unsure']);
  });

  it('makes the children of an unsure process unsure', () => {
    const l = ledger();
    track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 10 * S);
    track(l, [p(100, 1, T0), p(102, 101, T0 + 12 * S), p(103, 102, T0 + 13 * S)], T0 + 15 * S);
    expect(pids(l)).toEqual([
      [100, 'yes'],
      [101, 'yes'],
      [102, 'unsure'],
      [103, 'unsure'],
    ]);
  });

  it("keeps a reparented process in the root's group (Unix)", () => {
    const l = ledger();
    track(l, [p(100, 1, T0, 100), p(101, 100, T0 + S, 100)], T0 + 10 * S, []);
    // 101 exited and its child 102 was reparented to PID 1, but stays in the run's group.
    track(l, [p(100, 1, T0, 100), p(102, 1, T0 + 5 * S, 100)], T0 + 15 * S);
    expect(pids(l)).toContainEqual([102, 'yes']);
    // Another group, or no group (Windows), is not the run's.
    expect(track(l, [p(100, 1, T0, 100), p(300, 1, T0 + 5 * S, 300)], T0 + 20 * S)).toBe(0);
  });

  it('counts a process as alive only with the same PID and creation time', () => {
    const l = ledger();
    track(l, [p(100, 1, T0), p(101, 100, T0 + S)], T0 + 10 * S);
    const snap = [p(100, 1, T0), p(101, 7, T0 + 99 * S)];
    expect(survivors(l, snap).map((e) => e.pid)).toEqual([100]);
    expect(viewLedger(l, snap).map((v) => [v.pid, v.alive])).toEqual([
      [100, true],
      [101, false],
    ]);
  });

  it('parses /proc stat lines, names with spaces and parentheses included', () => {
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime
    // stime cutime cstime priority nice threads itrealvalue starttime ...
    const stat =
      '4321 (my (odd) name) S 100 4321 4321 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 12345 0 0';
    expect(parseLinuxStat(stat, 1_700_000_000)).toEqual({
      pid: 4321,
      ppid: 100,
      pgid: 4321,
      name: 'my (odd) name',
      start: 1_700_000_000_000 + 12345 * 10,
    });
    expect(parseLinuxStat('garbage', 1)).toBeNull();
  });

  it('parses Windows and ps snapshots', () => {
    const win = [
      '4\t0\t2026-11-01T11:59:00.1234567Z\tSystem\t',
      '1234\t4\t2026-11-01T12:00:00.5000000Z\tnode.exe\t"C:\\node.exe" run.js',
      'junk line',
      '99\t4\t\tIdle\t',
    ].join('\r\n');
    expect(parseWindows(win)).toEqual([
      { pid: 4, ppid: 0, name: 'System', cmd: '', start: Date.parse('2026-11-01T11:59:00.123Z') },
      {
        pid: 1234,
        ppid: 4,
        name: 'node.exe',
        cmd: '"C:\\node.exe" run.js',
        start: Date.parse('2026-11-01T12:00:00.500Z'),
      },
    ]);
    const ps = '  321     1   321 Sun Nov  1 12:00:05 2026 /usr/bin/node /tmp/run.js --x\n';
    expect(parsePs(ps)).toEqual([
      {
        pid: 321,
        ppid: 1,
        pgid: 321,
        name: 'node',
        cmd: '/usr/bin/node /tmp/run.js --x',
        start: Date.parse('Sun Nov 1 12:00:05 2026'),
      },
    ]);
  });
});

describe.runIf(process.platform === 'win32')('Windows process kills', () => {
  it('reports a refused kill as an error, and only a missing PID as gone', async () => {
    const lister = systemLister();
    try {
      const snap = await lister.list();
      // Windows PIDs are multiples of 4; well past the highest in the snapshot is unused.
      const missing = Math.max(...snap.map((x) => x.pid)) + 4_000;
      // The System process (PID 4) is always alive and refuses PROCESS_TERMINATE, elevated or
      // not. The open fails before the creation time is read, so `start` does not matter.
      const res = await lister.kill([
        { pid: 4, start: T0 },
        { pid: missing, start: T0 },
      ]);
      expect(res.get(4)).toBe('error');
      // A restrictive sandbox may refuse every terminate-capable OpenProcess call before Windows
      // can report that the PID is absent. `error` is the safe conservative result there.
      expect(['gone', 'error']).toContain(res.get(missing));
    } finally {
      lister.close();
    }
  }, 60_000);
});

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)(
  'Linux process kills',
  () => {
    it('reports a refused kill as an error, and only a missing PID as gone', async () => {
      const lister = systemLister();
      try {
        const snap = await lister.list();
        // PID 1 (init) is always alive and refuses SIGKILL from a user that is not root.
        const init = snap.find((x) => x.pid === 1);
        expect(init).toBeDefined();
        const missing = Math.max(...snap.map((x) => x.pid)) + 100_000;
        const res = await lister.kill([
          { pid: 1, start: init!.start },
          { pid: missing, start: T0 },
        ]);
        expect(res.get(1)).toBe('error');
        expect(res.get(missing)).toBe('gone');
      } finally {
        lister.close();
      }
    });
  },
);
