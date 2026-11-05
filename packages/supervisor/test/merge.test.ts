import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, secretKind, Workspace } from '@agent-ops/core';
import type { ProcLister, RunRecord } from '../src/index.js';
import {
  CommandRunner,
  MERGE_ACTOR,
  mergeSource,
  opsdConfig,
  Supervisor,
  systemLister,
} from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Whether `dir` could be removed: nothing holds it or a file in it any more. */
function removed(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The system's process lister, with every kill refused, as in a sandbox that allows none. */
function refusingLister(): ProcLister {
  const real = systemLister();
  return {
    precise: real.precise,
    clockSlack: real.clockSlack,
    list: () => real.list(),
    kill: (targets) => Promise.resolve(new Map(targets.map((t) => [t.pid, 'error' as const]))),
    ownPids: () => real.ownPids?.() ?? [],
    close: () => real.close(),
  };
}

/**
 * A lister that can neither list nor kill, as in a sandbox that refuses both. With `left`, it
 * lists only that process, for as long as `left.running` says so, and kills nothing.
 */
function blindLister(left?: { pid: number; start: number; running: boolean }): ProcLister {
  const listed = (l: NonNullable<typeof left>) =>
    l.running ? [{ pid: l.pid, ppid: 0, name: 'held', cmd: 'held', start: l.start }] : [];
  return {
    precise: true,
    clockSlack: 0,
    list: () => (left ? Promise.resolve(listed(left)) : Promise.reject(new Error('access denied'))),
    kill: (targets) => Promise.resolve(new Map(targets.map((t) => [t.pid, 'error' as const]))),
    close: () => {},
  };
}

const WIN = process.platform === 'win32';

/** Off Windows, ledgers, and with them killing what merge commands start, need exact creation times. */
const precise = systemLister().precise;

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-merge-'));
  dirs.push(d);
  return d;
}

const ID = {
  GIT_AUTHOR_NAME: 'Opsd Test',
  GIT_AUTHOR_EMAIL: 'opsd@example.com',
  GIT_COMMITTER_NAME: 'Opsd Test',
  GIT_COMMITTER_EMAIL: 'opsd@example.com',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ID },
  }).trim();
const text = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/**
 * Fails when `code.txt` says `bad`; waits for `go.txt` when it says `slow`; prints a token-like
 * line, then fails, when it says `leak`.
 */
const CHECK = `
import { existsSync, readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
const code = readFileSync('code.txt', 'utf8');
console.log('checking ' + code.trim());
appendFileSync(process.env.MERGE_COUNT, 'x');
if (code.includes('slow')) while (!existsSync(process.env.MERGE_GO)) await new Promise((r) => setTimeout(r, 50));
if (code.includes('bad')) { console.error('code says bad'); process.exit(1); }
if (code.includes('leak')) {
  console.log('GH_TOKEN=' + ['gh', 'p_'].join('') + 'A'.repeat(36));
  console.error('after the token');
  process.exit(1);
}
`;
/**
 * Builds `dist/built.txt` from `code.txt`. When it says `hold`, `held.mjs` builds it instead, in
 * a detached process: outside the shell's process group too, so only opsd's process ledger finds
 * it, as where `taskkill /T` is refused.
 */
const BUILD = `
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const code = readFileSync('code.txt', 'utf8');
if (code.includes('hold')) {
  const held = spawn(process.execPath, ['held.mjs'], { detached: true, stdio: 'inherit' });
  await new Promise((r) => held.on('exit', r));
} else {
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/built.txt', code);
}
`;
/** Writes its PID to `building.txt`, waits for `build-go.txt`, then builds. */
const HELD = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.MERGE_BUILDING, String(process.pid));
while (!existsSync(process.env.MERGE_BUILD_GO)) await new Promise((r) => setTimeout(r, 50));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/built.txt', readFileSync('code.txt', 'utf8'));
`;
/** A writing run that ends by itself once `run-go.txt` exists, so no test has to kill it. */
const RUN = `
import { existsSync } from 'node:fs';
while (!existsSync(process.env.RUN_GO)) await new Promise((r) => setTimeout(r, 50));
`;

/**
 * A project repo on `main` with code, check and build scripts and its task store committed, a
 * task `1` owned by `fake:engineer`, and opsd set to merge approved work into `main`.
 */
function mergeSetup(opts: { procs?: () => ProcLister } = {}) {
  const repo = temp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  writeFileSync(join(repo, 'code.txt'), 'one\n');
  writeFileSync(join(repo, 'check.mjs'), CHECK);
  writeFileSync(join(repo, 'build.mjs'), BUILD);
  writeFileSync(join(repo, 'held.mjs'), HELD);
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  const state = temp();
  const runFile = join(temp(), 'run.mjs');
  writeFileSync(runFile, RUN);
  const env = {
    ...process.env,
    ...ID,
    OPS_CONFIG: join(repo, 'none.yml'),
    OPS_STATE_DIR: state,
    MERGE_GO: join(state, 'go.txt'),
    MERGE_COUNT: join(state, 'checks.txt'),
    MERGE_BUILDING: join(state, 'building.txt'),
    MERGE_BUILD_GO: join(state, 'build-go.txt'),
    RUN_GO: join(state, 'run-go.txt'),
  } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  as('human:dawid').newTask({ title: 'Change the code', owner: 'fake:engineer' });
  as('human:dawid').newTask({ title: 'Other work', owner: 'fake:engineer' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  // Every verdict in these tests comes after opsd first saw the merge setting.
  writeFileSync(join(state, 'merge.json'), JSON.stringify({ test: '2000-01-01T00:00:00.000Z' }));
  const config = opsdConfig({
    opsd: {
      sync: false,
      runtimes: { fake: { command: process.execPath, args: [runFile] } },
      merge: { test: { base: 'main', checks: ['node check.mjs'], build: ['node build.mjs'] } },
    },
  });
  /** An opsd on the same state, like the one a restart starts. */
  const opsd = (): Supervisor => {
    const s = new Supervisor({
      env,
      cwd: repo,
      user: {},
      config,
      // Each opsd closes its own lister when it stops.
      procs: opts.procs?.(),
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(s);
    return s;
  };
  const sup = opsd();

  /** A branch `feature` from main's tip, in a worktree of its own, with `code.txt` as `code`. */
  const branch = (code: string): string => {
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), code);
    git(wt, 'commit', '-qam', 'Change the code');
    return git(wt, 'rev-parse', 'HEAD');
  };
  /** A commit on main in the repo's own checkout, as another merge or a sync makes. */
  const onMain = (file: string, content: string): string => {
    writeFileSync(join(repo, file), content);
    git(repo, 'add', '--', file);
    git(repo, 'commit', '-qm', `Change ${file}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  /** Task 1 through review and approval, with the review naming `commit` on `feature`. */
  const approve = (commit: string): void => {
    as('fake:engineer').start('1', 'plan');
    as('fake:engineer').review(
      '1',
      `${commit.slice(0, 7)} on branch feature: changes the code, tests`,
      'human:dawid',
    );
    as('human:dawid').verdict('1', 'approve', 'looks right');
  };
  const merged = async (): Promise<void> => {
    await sup.tick();
    await sup.mergeSettled();
  };
  const last = () => as('human:dawid').showEvents('1').events.at(-1)!;
  return { repo, sup, opsd, as, state, branch, onMain, approve, merged, last };
}

function ended(sup: Supervisor, id: string, ms = 15_000): Promise<RunRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run ${id} did not end`)), ms);
    const check = (r: RunRecord): void => {
      if (r.id !== id || r.status !== 'ended') return;
      clearTimeout(timer);
      sup.off('run', check);
      resolve(r);
    };
    sup.on('run', check);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('merging approved work', () => {
  it('reads the branch and commit a review names', () => {
    expect(mergeSource('3959772 on branch claude/ao-0103-run-commit (pushed; worktree x)')).toEqual(
      { commit: '3959772', branch: 'claude/ao-0103-run-commit' },
    );
    expect(mergeSource('abc1234 on branch `fix/a.b`: done')).toEqual({
      commit: 'abc1234',
      branch: 'fix/a.b',
    });
    expect(mergeSource('Work is on branch feature/x. Tests pass.')).toEqual({
      branch: 'feature/x',
    });
    expect(mergeSource('PR: https://github.com/o/r/pull/1')).toBeNull();
  });

  it('rebases onto the base, runs the checks, fast-forwards the base, builds and records it', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    // main moves on after the branch was cut, so the merge is a real rebase.
    const before = s.onMain('other.txt', 'other\n');
    s.approve(commit);
    // The task store has events no commit holds; a merge leaves them alone.
    const pending = git(s.repo, 'status', '--porcelain', '--', '.agent-ops');
    expect(pending).not.toBe('');
    await s.merged();

    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}^`)).toBe(before);
    expect(git(s.repo, 'log', '-1', '--format=%s', tip)).toBe('Change the code');
    // The checkout follows main, and the build ran there.
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(text(join(s.repo, 'other.txt'))).toBe('other\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(git(s.repo, 'status', '--porcelain', '--', '.agent-ops')).toBe(pending);

    expect(s.as('human:dawid').view('1').status).toBe('done');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'merge',
      actor: MERGE_ACTOR,
      commit: tip,
      into: 'main',
      branch: 'feature',
    });
    expect(e.body).toContain(`as ${tip.slice(0, 7)}, rebased onto ${before.slice(0, 7)}`);
    expect(e.body).toContain('Checks passed: `node check.mjs`.');
    expect(e.body).toContain('Built with `node build.mjs`.');

    // Done once: a second tick merges nothing again.
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(
      s
        .as('human:dawid')
        .showEvents('1')
        .events.filter((x) => x.type === 'merge'),
    ).toHaveLength(1);
  });

  it('sends the task back on a conflict and leaves the base alone', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const before = s.onMain('code.txt', 'three\n');
    s.approve(commit);
    await s.merged();

    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(text(join(s.repo, 'code.txt'))).toBe('three\n');
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    const v = s.as('human:dawid').view('1');
    expect(v.status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain(`opsd did not merge ${commit.slice(0, 7)} on branch feature`);
    expect(e.body).toContain(`does not rebase onto main (${before.slice(0, 7)})`);
    expect(e.body).toContain('conflicts in code.txt');
    // The engineer has it in the inbox.
    expect(
      s
        .as('fake:engineer')
        .inbox()
        .some((i) => i.task.endsWith('1')),
    ).toBe(true);
  });

  it('sends the task back with the output when a check fails', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('bad\n');
    s.approve(commit);
    await s.merged();

    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    expect(s.as('human:dawid').view('1').status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('`node check.mjs` failed (exit 1)');
    expect(e.body).toContain('checking bad');
    expect(e.body).toContain('code says bad');
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log && text(log)).toContain('code says bad');
  });

  it('rebases again when the base moves during the checks, and checks again only for code', async () => {
    const s = mergeSetup();
    const count = () =>
      existsSync(join(s.state, 'checks.txt')) ? text(join(s.state, 'checks.txt')).length : 0;
    const commit = s.branch('slow\n');
    s.approve(commit);
    await s.sup.tick();
    await until(() => count() === 1);
    // A task store sync lands on main while the check runs: no code changed.
    const synced = s.onMain('.agent-ops/sync-note.md', 'note\n');
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}^`)).toBe(synced);
    expect(count()).toBe(1);
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
  });

  it('records work already in the base without moving it', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    git(s.repo, 'merge', '-q', '--ff-only', 'feature');
    const tip = git(s.repo, 'rev-parse', 'main');
    s.approve(commit);
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(existsSync(join(s.state, 'checks.txt'))).toBe(false);
    expect(s.last()).toMatchObject({ type: 'merge', commit: tip });
    expect(s.last().body).toContain('is already in main; nothing to merge');
  });

  it('sends back a branch that changes task store files', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const wt = join(temp(), 'wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), 'two\n');
    writeFileSync(join(wt, '.agent-ops', 'stray.md'), 'stray\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Change the code');
    s.approve(git(wt, 'rev-parse', 'HEAD'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(s.last().body).toContain('changes task store files (.agent-ops/stray.md)');
  });

  it('merges nothing approved before opsd first saw the merge setting', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    rmSync(join(s.state, 'merge.json'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last().type).toBe('verdict');
  });

  it('waits for a writing run in the checkout, and holds the checkout while it merges', async () => {
    const s = mergeSetup();
    const commit = s.branch('slow\n');
    s.approve(commit);
    const before = git(s.repo, 'rev-parse', 'main');
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last().type).toBe('verdict');

    // The run ends by itself: a killed run's process may outlive the kill on Windows, keeping
    // the scratch repo busy past the test.
    const end = ended(s.sup, run.id);
    writeFileSync(join(s.state, 'run-go.txt'), 'go\n');
    await end;
    // The check waits for go.txt, so the merge stays under way.
    await s.sup.tick();
    expect(s.sup.merge).toMatchObject({ base: 'main' });
    expect(() => s.sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /^opsd merges test\/T-0001 into main in /,
    );
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(s.sup.merge).toBeNull();
    expect(text(join(s.repo, 'code.txt'))).toBe('slow\n');
    expect(s.last()).toMatchObject({ type: 'merge', commit: git(s.repo, 'rev-parse', 'main') });
  });

  it.runIf(precise)(
    'records the merge when opsd stops during the build, ends what the build started, and builds again after a restart',
    async () => {
      const s = mergeSetup();
      const commit = s.branch('hold\n');
      s.approve(commit);
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')));
      const build = Number(text(join(s.state, 'building.txt')));
      const tip = git(s.repo, 'rev-parse', 'main');
      expect(text(join(s.repo, 'code.txt'))).toBe('hold\n');
      s.sup.stop();
      await s.sup.close();

      // The stop ended the detached build process too: nothing is left to race the next build.
      expect(alive(build)).toBe(false);
      expect(existsSync(join(s.state, 'merge-procs.json'))).toBe(false);
      // The base moved, so the merge is on record; the build is not done.
      expect(existsSync(join(s.repo, 'dist', 'built.txt'))).toBe(false);
      const e = s.last();
      expect(e).toMatchObject({ type: 'merge', actor: MERGE_ACTOR, commit: tip });
      expect(e.body).toContain('was stopped with opsd; the next opsd runs the build again');
      expect(s.as('human:dawid').view('1').status).toBe('done');

      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const next = s.opsd();
      await next.tick();
      await next.mergeSettled();
      expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('hold\n');
      expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(s.last().body).toContain('Built main with `node build.mjs` after a restart');
      // One merge event, and the build is not run a third time.
      expect(
        s
          .as('human:dawid')
          .showEvents('1')
          .events.filter((x) => x.type === 'merge'),
      ).toHaveLength(1);
      const events = s.as('human:dawid').showEvents('1').events.length;
      await next.tick();
      await next.mergeSettled();
      expect(s.as('human:dawid').showEvents('1').events).toHaveLength(events);
    },
    45_000,
  );

  // On Windows the job object ends the build whatever the lister can do; see the next test.
  it.runIf(precise && !WIN)(
    'waits for a build no kill could end before it builds again',
    async () => {
      const s = mergeSetup({ procs: refusingLister });
      const warns: string[] = [];
      s.approve(s.branch('hold\n'));
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')));
      const build = Number(text(join(s.state, 'building.txt')));
      s.sup.stop();
      await s.sup.close();

      // The detached build survived every kill; opsd keeps it on record.
      expect(alive(build)).toBe(true);
      const left = JSON.parse(text(join(s.state, 'merge-procs.json'))) as Array<{ pid: number }>;
      expect(left.map((p) => p.pid)).toContain(build);
      expect(s.last().body).toContain('the next opsd runs the build again');

      // The next opsd neither builds nor merges while it runs.
      const next = s.opsd();
      next.on('warn', (m: string) => warns.push(m));
      await next.tick();
      await next.mergeSettled();
      expect(next.merge).toBeNull();
      expect(existsSync(join(s.repo, 'dist'))).toBe(false);
      expect(warns.join('\n')).toContain('waiting for what an earlier merge left running');

      // Once it ends by itself, the next look clears it and the build runs.
      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const end = Date.now() + 15_000;
      while (s.last().type !== 'comment' && Date.now() < end) {
        await next.tick();
        await next.mergeSettled();
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(alive(build)).toBe(false);
      expect(JSON.parse(text(join(s.state, 'merge-procs.json')))).toEqual([]);
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(s.last().body).toContain('Built main with `node build.mjs` after a restart');
    },
    45_000,
  );

  it.runIf(WIN)(
    'ends the whole build on a stop where listing and killing processes are refused, and waits for recorded leftovers',
    async () => {
      // The sandbox case: no process list, no kill by PID. Only the job object can end the build.
      let lister = blindLister();
      const s = mergeSetup({ procs: () => lister });
      s.approve(s.branch('hold\n'));
      await s.sup.tick();
      await until(() => existsSync(join(s.state, 'building.txt')));
      const build = Number(text(join(s.state, 'building.txt')));
      const start = Date.now();
      s.sup.stop();
      await s.sup.close();
      expect(Date.now() - start).toBeLessThan(10_000);
      expect(alive(build)).toBe(false);
      expect(existsSync(join(s.state, 'merge-procs.json'))).toBe(false);
      expect(s.last().body).toContain('the next opsd runs the build again');

      // A leftover on record, from an opsd before this one, holds the build until it is gone.
      const left = { pid: 999_999, start: Date.now() - 60_000, running: true };
      writeFileSync(
        join(s.state, 'merge-procs.json'),
        JSON.stringify([
          { ...left, ppid: 0, name: 'held', cmd: 'held', first_seen: '', last_seen: '' },
        ]),
      );
      writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
      const warns: string[] = [];
      lister = blindLister(left);
      const next = s.opsd();
      next.on('warn', (m: string) => warns.push(m));
      await next.tick();
      await next.mergeSettled();
      expect(existsSync(join(s.repo, 'dist'))).toBe(false);
      expect(warns.join('\n')).toContain('waiting for what an earlier merge left running');

      left.running = false;
      const end = Date.now() + 15_000;
      while (s.last().type !== 'comment' && Date.now() < end) {
        await next.tick();
        await next.mergeSettled();
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
      expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('hold\n');
    },
    45_000,
  );

  it.runIf(WIN)('runs each command in a job object that ends everything it started', async () => {
    const dir = temp();
    // tree.mjs starts a detached child, which starts one more; each writes its PID and waits.
    writeFileSync(
      join(dir, 'tree.mjs'),
      `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const depth = Number(process.argv[2] ?? 0);
writeFileSync('pid' + depth + '.txt', String(process.pid));
if (depth < 2) spawn(process.execPath, ['tree.mjs', String(depth + 1)], { detached: depth === 0, stdio: 'ignore' });
if (depth === 0 && process.argv[3] === 'exit') {
  while (!existsSync('pid2.txt')) await new Promise((r) => setTimeout(r, 50));
  process.exit(3);
}
setInterval(() => {}, 1000);
`,
    );
    const pids = (): number[] => [0, 1, 2].map((d) => Number(text(join(dir, `pid${d}.txt`))));
    const ready = (): boolean => [0, 1, 2].every((d) => existsSync(join(dir, `pid${d}.txt`)));

    // A stop ends the tree, detached child included.
    const runner = new CommandRunner(process.env, { killTree: () => {} });
    const stopped = runner.runAll(['node tree.mjs 0'], dir, 60_000);
    await until(ready);
    const first = pids();
    runner.stop();
    expect((await stopped)[0]).toMatchObject({ ok: false, why: 'stopped' });
    await until(() => first.every((p) => !alive(p)));

    // A command that exits by itself keeps its exit code and leaves nothing running.
    for (const d of [0, 1, 2]) rmSync(join(dir, `pid${d}.txt`));
    const [r] = await new CommandRunner(process.env).runAll(['node tree.mjs 0 exit'], dir, 60_000);
    expect(r).toMatchObject({ ok: false, why: 'exit 3' });
    await until(() => pids().every((p) => !alive(p)));
    await until(() => removed(dir), 15_000);
  });

  it('ends a stopped command even when what it started outlives the stop', async () => {
    const dir = temp();
    const pid = join(dir, 'pid.txt');
    const go = join(dir, 'go.txt');
    // Holds the output open until go.txt exists.
    writeFileSync(
      join(dir, 'hold.mjs'),
      `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pid)}, String(process.pid));
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 50));
`,
    );
    // No job, no watch and no group kill: ending the shell may leave node running.
    const runner = new CommandRunner(process.env, { killTree: () => {}, job: false });
    const result = runner.runAll(['node hold.mjs'], dir, 60_000);
    await until(() => existsSync(pid) && text(pid) !== '');
    const start = Date.now();
    runner.stop();
    const [r] = await result;
    expect(r).toMatchObject({ ok: false, why: 'stopped' });
    expect(Date.now() - start).toBeLessThan(9_000);
    // The leftover ends by itself and lets go of the folder.
    writeFileSync(go, 'go\n');
    await until(() => removed(dir), 15_000);
  });

  it('keeps secret-looking output out of the send-back and the log', async () => {
    const s = mergeSetup();
    s.approve(s.branch('leak\n'));
    await s.merged();
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(secretKind(e.body)).toBeNull();
    expect(e.body).toContain('[line removed: it looks like a GitHub token]');
    expect(e.body).toContain('after the token');
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log).toBeDefined();
    const kept = text(log!);
    expect(secretKind(kept)).toBeNull();
    expect(kept).toContain('after the token');
    // Nothing else opsd keeps holds it either.
    for (const f of readdirSync(join(s.state, 'merge', 'logs'))) {
      expect(secretKind(text(join(s.state, 'merge', 'logs', f)))).toBeNull();
    }
  });
});
