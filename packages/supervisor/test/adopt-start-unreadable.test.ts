import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initRoot } from '@agent-ops/core';
import { opsdConfig, Supervisor } from '../src/index.js';

// What a creation-time read returns: `null` stands for PowerShell timing out on a loaded machine.
// `hang` keeps the async read pending until its signal aborts, as a PowerShell stuck under load.
const reads = vi.hoisted(() => ({
  sync: null as string | null,
  async: null as string | null,
  hang: false,
  signals: [] as Array<AbortSignal | undefined>,
}));

vi.mock('../src/proc.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/proc.js')>();
  return {
    ...orig,
    processStartSync: () => reads.sync,
    processStart: (_pid: number, signal?: AbortSignal) => {
      reads.signals.push(signal);
      if (!reads.hang) return Promise.resolve(reads.async);
      return new Promise<string | null>((resolveStart) => {
        signal?.addEventListener('abort', () => resolveStart(null), { once: true });
      });
    },
  };
});

beforeEach(() => {
  reads.hang = false;
  reads.signals = [];
});

const dirs: string[] = [];
const children: ChildProcess[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const s of sups.splice(0)) {
    s.stop();
    await s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-adopt-'));
  dirs.push(d);
  return d;
}

/** A supervisor with a saved running record for a live process, as a restart finds it. */
function restartWithLiveRun(): { sup: Supervisor; id: string } {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const state = temp();
  const env = {
    ...process.env,
    OPS_CONFIG: join(repo, 'none.yml'),
    OPS_STATE_DIR: state,
  } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const sup = new Supervisor({
    env,
    cwd: repo,
    user: {},
    config: opsdConfig({ opsd: { sync: false } }),
    freeMem: () => 64 * 2 ** 30,
    // The run is left alone at the end; the test kills its process.
    runsOutlive: true,
  });
  sups.push(sup);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
  });
  children.push(child);
  const id = '01DDDDDDDDDDDDDDDDDDDDDDD1';
  sup.store.save({
    id,
    agent: 'fake:engineer',
    command: 'x',
    cwd: state,
    log: join(state, 'none.log'),
    started_at: new Date().toISOString(),
    status: 'running',
    budget_minutes: 60,
    tokens: 0,
    pid: child.pid!,
    image: 'node.exe',
    proc_start: 'recorded-start',
  });
  return { sup, id };
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('adoption when the creation time cannot be read', () => {
  it('keeps a live run adopted when the second read matches', async () => {
    reads.sync = null;
    reads.async = 'recorded-start';
    const { sup, id } = restartWithLiveRun();
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    sup.adopt();
    expect(sup.run(id).status).toBe('running');
    await until(() => warns.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.run(id).status).toBe('running');
    expect(warns).toEqual([expect.stringMatching(/could not read the creation time/)]);
  });

  it('ends the run as lost once a second read shows another process', async () => {
    reads.sync = null;
    reads.async = 'another-start';
    const { sup, id } = restartWithLiveRun();
    sup.adopt();
    await until(() => sup.run(id).status === 'ended');
    expect(sup.run(id).reason).toBe('lost');
  });

  it('stop cancels a pending read and leaves the run to the next opsd', async () => {
    reads.sync = null;
    reads.hang = true;
    const { sup, id } = restartWithLiveRun();
    sup.adopt();
    await until(() => reads.signals.length > 0);
    const signal = reads.signals[0];
    expect(signal?.aborted).toBe(false);
    sup.stop();
    expect(signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    // Not lost: the read was cancelled, not answered.
    expect(sup.run(id).status).toBe('running');
    expect(reads.signals).toHaveLength(1);
  });

  it('stop clears the timer of the wait between reads', async () => {
    reads.sync = null;
    reads.async = null;
    const { sup, id } = restartWithLiveRun();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sup.adopt();
      // The first read answers null at once; the recheck then waits for the next read.
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.signals).toHaveLength(1);
      const waiting = vi.getTimerCount();
      expect(waiting).toBeGreaterThan(0);
      sup.stop();
      expect(vi.getTimerCount()).toBe(waiting - 1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads.signals).toHaveLength(1);
      expect(sup.run(id).status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still marks a run lost when the first read shows another process', () => {
    reads.sync = 'another-start';
    reads.async = 'another-start';
    const { sup, id } = restartWithLiveRun();
    sup.adopt();
    expect(sup.run(id)).toMatchObject({ status: 'ended', reason: 'lost' });
  });
});
