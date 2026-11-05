import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@agent-ops/core';
import type { BranchPushOptions } from '../src/index.js';
import { BranchPusher, gitError, opsdConfig, Supervisor } from '../src/index.js';

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

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-push-'));
  dirs.push(d);
  return d;
}

const ID = {
  GIT_AUTHOR_NAME: 'Opsd Test',
  GIT_AUTHOR_EMAIL: 'opsd@example.com',
  GIT_COMMITTER_NAME: 'Opsd Test',
  GIT_COMMITTER_EMAIL: 'opsd@example.com',
};
const ENV = { ...process.env, ...ID } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: ENV,
  }).trim();

/** The commit `ref` names in the bare remote, or null. */
function remoteRef(bare: string, ref: string): string | null {
  try {
    return git(bare, 'rev-parse', '-q', '--verify', `${ref}^{commit}`);
  } catch {
    return null;
  }
}

/** A bare scratch remote and a clone of it on `main`, with one commit pushed. */
function repoSetup() {
  const bare = join(temp(), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', bare);
  writeFileSync(join(repo, 'code.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  /** A commit on `branch` (made from `from`, default main) changing `file`; returns it. */
  const commit = (branch: string, file: string, content: string, from = 'main'): string => {
    const exists = git(repo, 'branch', '--list', branch) !== '';
    git(repo, 'checkout', '-q', exists ? branch : '-b', ...(exists ? [] : [branch, from]));
    writeFileSync(join(repo, file), content);
    git(repo, 'add', '--', file);
    git(repo, 'commit', '-qm', `Change ${file} on ${branch}`);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    return sha;
  };
  return { bare, repo, commit };
}

const OPTS: BranchPushOptions = {
  prefixes: ['claude/', 'codex/'],
  bases: ['main'],
  merged: {},
  seen: {},
};

describe('pushing task branches', () => {
  it('pushes task branches with new commits, and nothing else', () => {
    const { bare, repo, commit } = repoSetup();
    const work = commit('claude/ao-1-work', 'a.txt', 'a\n');
    const leftover = commit('codex/ao-2-01abc', 'b.txt', 'b\n');
    // Other names, a base and a task branch with nothing beyond main stay here.
    commit('feature/x', 'c.txt', 'c\n');
    git(repo, 'branch', 'claude/ao-3-empty', 'main');
    const mainTip = commit('main', 'main.txt', 'local\n');

    const round = new BranchPusher(repo, ENV).pushNew(OPTS);
    expect(round.remote).toBe('origin');
    expect(round.error).toBeUndefined();
    expect(round.pushed.map((p) => p.branch).sort()).toEqual([
      'claude/ao-1-work',
      'codex/ao-2-01abc',
    ]);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-work')).toBe(work);
    expect(remoteRef(bare, 'refs/heads/codex/ao-2-01abc')).toBe(leftover);
    expect(remoteRef(bare, 'refs/heads/feature/x')).toBeNull();
    expect(remoteRef(bare, 'refs/heads/claude/ao-3-empty')).toBeNull();
    // The base moves only with the normal sync.
    expect(remoteRef(bare, 'refs/heads/main')).not.toBe(mainTip);

    // Nothing new: a second round pushes nothing.
    const again = new BranchPusher(repo, ENV).pushNew({ ...OPTS, seen: round.seen });
    expect(again.pushed).toEqual([]);

    // A follow-up commit goes up as a fast-forward.
    const more = commit('claude/ao-1-work', 'a.txt', 'a2\n');
    const third = new BranchPusher(repo, ENV).pushNew({ ...OPTS, seen: again.seen });
    expect(third.pushed).toEqual([{ branch: 'claude/ao-1-work', tip: more }]);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-work')).toBe(more);
  });

  it('skips a branch merged by cherry-pick and the tip opsd merged', () => {
    const { bare, repo, commit } = repoSetup();
    const picked = commit('claude/ao-1-picked', 'a.txt', 'a\n');
    commit('main', 'other.txt', 'other\n');
    git(repo, 'cherry-pick', picked);
    const approved = commit('claude/ao-2-merged', 'b.txt', 'b\n');

    const round = new BranchPusher(repo, ENV).pushNew({
      ...OPTS,
      merged: { 'claude/ao-2-merged': approved },
    });
    expect(round.pushed).toEqual([]);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-picked')).toBeNull();
    expect(remoteRef(bare, 'refs/heads/claude/ao-2-merged')).toBeNull();

    // New work on top of what was merged goes up again.
    const fix = commit('claude/ao-2-merged', 'b.txt', 'b fixed\n');
    const next = new BranchPusher(repo, ENV).pushNew({
      ...OPTS,
      merged: { 'claude/ao-2-merged': approved },
    });
    expect(next.pushed).toEqual([{ branch: 'claude/ao-2-merged', tip: fix }]);
  });

  it('never forces: a diverged remote branch is held back and named', () => {
    const { bare, repo, commit } = repoSetup();
    commit('claude/ao-1-work', 'a.txt', 'a\n');
    new BranchPusher(repo, ENV).pushNew(OPTS);
    // Another clone pushes to the branch; this clone rewrites its own.
    const other = join(temp(), 'other');
    git(temp(), 'clone', '-q', bare, other);
    git(other, 'checkout', '-q', 'claude/ao-1-work');
    writeFileSync(join(other, 'a.txt'), 'theirs\n');
    git(other, 'commit', '-qam', 'theirs');
    git(other, 'push', '-q');
    const theirs = git(other, 'rev-parse', 'HEAD');
    git(repo, 'fetch', '-q');
    git(repo, 'checkout', '-q', 'claude/ao-1-work');
    git(repo, 'reset', '-q', '--hard', 'main');
    git(repo, 'checkout', '-q', 'main');
    commit('claude/ao-1-work', 'a.txt', 'mine\n');

    const round = new BranchPusher(repo, ENV).pushNew(OPTS);
    expect(round.pushed).toEqual([]);
    expect(round.held).toEqual([
      {
        branch: 'claude/ao-1-work',
        why: 'origin/claude/ao-1-work has commits this clone lacks; opsd never forces a push',
      },
    ]);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-work')).toBe(theirs);
    // Named once: the next round with the same tips says nothing.
    expect(new BranchPusher(repo, ENV).pushNew({ ...OPTS, seen: round.seen }).held).toEqual([]);
  });

  it('refuses a push the remote moved under, without forcing', () => {
    const { bare, repo, commit } = repoSetup();
    commit('claude/ao-1-work', 'a.txt', 'a\n');
    new BranchPusher(repo, ENV).pushNew(OPTS);
    // Another clone pushes; this clone has not fetched, so its remote branch looks behind.
    const other = join(temp(), 'other');
    git(temp(), 'clone', '-q', bare, other);
    git(other, 'checkout', '-q', 'claude/ao-1-work');
    writeFileSync(join(other, 'z.txt'), 'theirs\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'theirs');
    git(other, 'push', '-q');
    const theirs = git(other, 'rev-parse', 'HEAD');
    commit('claude/ao-1-work', 'a.txt', 'mine\n');

    const round = new BranchPusher(repo, ENV).pushNew(OPTS);
    expect(round.pushed).toEqual([]);
    expect(round.error).toBeUndefined();
    expect(round.held[0]!.why).toMatch(/^origin refused it \(.*rejected.*\); opsd never forces/);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-work')).toBe(theirs);
  });

  it('holds back a branch whose new commits add a secret or a key file', () => {
    const { bare, repo, commit } = repoSetup();
    const token = ['gh', 'p_'].join('') + 'A'.repeat(36);
    commit('claude/ao-1-leak', 'cfg.txt', `GH_TOKEN=${token}\n`);
    // Added, then taken out again: still in what a push would carry.
    commit('claude/ao-1-leak', 'cfg.txt', 'clean\n');
    commit('claude/ao-2-key', 'deploy.pem', 'not really a key\n');
    const round = new BranchPusher(repo, ENV).pushNew(OPTS);
    expect(round.pushed).toEqual([]);
    expect(round.held).toEqual([
      {
        branch: 'claude/ao-1-leak',
        why: 'a commit on it adds what looks like a GitHub token in cfg.txt; not pushed',
      },
      { branch: 'claude/ao-2-key', why: 'a commit on it adds a key file (deploy.pem); not pushed' },
    ]);
    expect(JSON.stringify(round)).not.toContain(token);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-leak')).toBeNull();

    // A binary key file has no `+++` header in the diff, only a `Binary files` line.
    commit('claude/ao-3-binary', 'cert.p12', '\u0000\u0001binary\u0000');
    const binary = new BranchPusher(repo, ENV).pushNew({ ...OPTS, seen: round.seen });
    expect(binary.held).toEqual([
      {
        branch: 'claude/ao-3-binary',
        why: 'a commit on it adds a key file (cert.p12); not pushed',
      },
    ]);
  });

  /** Merges `from` into `branch` in `repo`, leaving a conflict, if any, unresolved and uncommitted. */
  function mergeInto(repo: string, branch: string, from: string): void {
    git(repo, 'checkout', '-q', branch);
    try {
      git(repo, 'merge', '-q', '--no-ff', '--no-commit', from);
    } catch {
      // A conflict: the caller resolves it.
    }
  }

  it('scans what a merge commit adds: a conflict resolution and an edit made in the merge', () => {
    const { bare, repo, commit } = repoSetup();
    const token = ['gh', 'p_'].join('') + 'B'.repeat(36);
    commit('claude/ao-1-resolve', 'cfg.txt', 'ours\n');
    commit('claude/ao-2-evil', 'x.txt', 'x\n');
    commit('main', 'cfg.txt', 'base\n');

    // The secret exists only in the conflict resolution, in neither parent.
    mergeInto(repo, 'claude/ao-1-resolve', 'main');
    writeFileSync(join(repo, 'cfg.txt'), `GH_TOKEN=${token}\n`);
    git(repo, 'add', '--', 'cfg.txt');
    git(repo, 'commit', '-qm', 'Merge main');
    // A clean merge that adds a key file nobody committed elsewhere.
    mergeInto(repo, 'claude/ao-2-evil', 'main');
    writeFileSync(join(repo, 'id.pem'), 'not really a key\n');
    git(repo, 'add', '--', 'id.pem');
    git(repo, 'commit', '-qm', 'Merge main');
    git(repo, 'checkout', '-q', 'main');

    const round = new BranchPusher(repo, ENV).pushNew(OPTS);
    expect(round.pushed).toEqual([]);
    expect(round.held).toEqual([
      {
        branch: 'claude/ao-1-resolve',
        why: 'a commit on it adds what looks like a GitHub token in cfg.txt; not pushed',
      },
      { branch: 'claude/ao-2-evil', why: 'a commit on it adds a key file (id.pem); not pushed' },
    ]);
    expect(JSON.stringify(round)).not.toContain(token);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-resolve')).toBeNull();
    expect(remoteRef(bare, 'refs/heads/claude/ao-2-evil')).toBeNull();
  });

  it('pushes a merge whose resolution is the only new work, and not a clean merge', () => {
    const { bare, repo, commit } = repoSetup();
    commit('claude/ao-1-work', 'cfg.txt', 'ours\n');
    commit('claude/ao-2-work', 'y.txt', 'y\n');
    const seen = new BranchPusher(repo, ENV).pushNew(OPTS).seen;
    commit('main', 'cfg.txt', 'base\n');

    mergeInto(repo, 'claude/ao-1-work', 'main');
    writeFileSync(join(repo, 'cfg.txt'), 'ours and base\n');
    git(repo, 'add', '--', 'cfg.txt');
    git(repo, 'commit', '-qm', 'Merge main');
    const resolved = git(repo, 'rev-parse', 'HEAD');
    mergeInto(repo, 'claude/ao-2-work', 'main');
    git(repo, 'commit', '-qm', 'Merge main');
    const clean = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');

    const round = new BranchPusher(repo, ENV).pushNew({ ...OPTS, seen });
    expect(round.held).toEqual([]);
    expect(round.pushed).toEqual([{ branch: 'claude/ao-1-work', tip: resolved }]);
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-work')).toBe(resolved);
    // A clean merge of the base carries nothing that is not already on the remote.
    expect(remoteRef(bare, 'refs/heads/claude/ao-2-work')).not.toBe(clean);
  });

  it('stops the round on an unreachable remote and keeps URLs out of the message', () => {
    const { repo, commit } = repoSetup();
    commit('claude/ao-1-work', 'a.txt', 'a\n');
    const gone = join(temp(), 'gone.git');
    git(repo, 'remote', 'set-url', 'origin', `file://user:hunter2@localhost/${gone}`);
    const round = new BranchPusher(repo, ENV).pushNew({ ...OPTS, seen: { 'codex/x': 'a b' } });
    expect(round.pushed).toEqual([]);
    expect(round.error).toMatch(/^push of claude\/ao-1-work to origin failed: /);
    expect(round.error).not.toContain('hunter2');
    // Nothing was decided: the next round tries again, and earlier decisions stay.
    expect(round.seen).toEqual({ 'codex/x': 'a b' });
    expect(gitError({ stderr: "fatal: unable to access 'https://x:secret@h/r.git/'" })).toBe(
      "fatal: unable to access '<url>'",
    );
    expect(gitError({ stderr: "fatal: '//x:secret@h/r.git' does not appear" })).toBe(
      "fatal: '//h/r.git' does not appear",
    );
  });

  it('does nothing in a repo without a remote', () => {
    const repo = temp();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'start');
    git(repo, 'branch', 'claude/ao-1', 'main');
    expect(new BranchPusher(repo, ENV).pushNew(OPTS)).toMatchObject({ remote: null, pushed: [] });
  });

  it('deletes a remote branch only while it holds nothing beyond the approved commit', () => {
    const { bare, repo, commit } = repoSetup();
    const approved = commit('claude/ao-1-work', 'a.txt', 'a\n');
    const pusher = new BranchPusher(repo, ENV);
    pusher.pushNew(OPTS);
    expect(pusher.deleteRemote('origin', 'claude/ao-1-work', approved)).toBe('deleted');
    expect(remoteRef(bare, 'refs/heads/claude/ao-1-work')).toBeNull();
    expect(pusher.deleteRemote('origin', 'claude/ao-1-work', approved)).toBe('absent');

    const first = commit('claude/ao-2-work', 'b.txt', 'b\n');
    const later = commit('claude/ao-2-work', 'b.txt', 'b2\n');
    pusher.pushNew(OPTS);
    expect(pusher.deleteRemote('origin', 'claude/ao-2-work', first)).toMatch(
      /^kept origin\/claude\/ao-2-work: it has commits the approval did not cover/,
    );
    expect(remoteRef(bare, 'refs/heads/claude/ao-2-work')).toBe(later);
  });

  it('turns off per root in the opsd config', () => {
    expect(opsdConfig({}).push_branches).toEqual({});
    expect(opsdConfig({ opsd: { push_branches: { v2: false } } }).push_branches).toEqual({
      v2: false,
    });
    expect(() => opsdConfig({ opsd: { push_branches: { v2: 'no' } } } as never)).toThrow(
      /push_branches\.v2: use true or false/,
    );
  });
});

describe('opsd pushing task branches at sync', () => {
  /**
   * A clone of a bare remote with a task store at its top, task `1` owned by `fake:engineer`, and
   * an opsd that syncs, with a clock the test moves.
   */
  function opsdSetup(opsd: Record<string, unknown> = {}) {
    const { bare, repo, commit } = repoSetup();
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const state = temp();
    const env = {
      ...ENV,
      OPS_CONFIG: join(repo, 'none.yml'),
      OPS_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.OPS_AGENT;
    delete env.OPS_ROOTS;
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
    as('human:dawid').newTask({ title: 'Change the code', owner: 'fake:engineer' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'store');
    git(repo, 'push', '-q');
    writeFileSync(join(state, 'merge.json'), JSON.stringify({ test: '2000-01-01T00:00:00.000Z' }));
    let clock = Date.now();
    const sup = new Supervisor({
      env,
      cwd: repo,
      user: {},
      config: opsdConfig({
        opsd: { sync: true, runtimes: { fake: { command: process.execPath } }, ...opsd },
      }),
      freeMem: () => 64 * 2 ** 30,
      now: () => clock,
    });
    sups.push(sup);
    /** One tick with the root's push due, and any merge it starts run to its end. */
    const tick = async (): Promise<void> => {
      clock += 31 * 60_000;
      await sup.tick();
      await sup.mergeSettled();
    };
    return { bare, repo, commit, as, state, sup, tick };
  }

  it('pushes task branches with new commits when the root syncs', async () => {
    const s = opsdSetup();
    const work = s.commit('fake/ao-1-01abc', 'a.txt', 'a\n');
    s.commit('other/ao-2', 'b.txt', 'b\n');
    const seen: unknown[] = [];
    s.sup.on('branches', (b) => seen.push(b));
    await s.tick();
    expect(remoteRef(s.bare, 'refs/heads/fake/ao-1-01abc')).toBe(work);
    expect(remoteRef(s.bare, 'refs/heads/other/ao-2')).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('pushes nothing for a root set to false', async () => {
    const s = opsdSetup({ push_branches: { test: false } });
    s.commit('fake/ao-1-01abc', 'a.txt', 'a\n');
    await s.tick();
    expect(remoteRef(s.bare, 'refs/heads/fake/ao-1-01abc')).toBeNull();
  });

  it('deletes a merged branch on the remote once the remote base has the merge', async () => {
    const s = opsdSetup({ merge: { test: { base: 'main' } } });
    const approved = s.commit('fake/ao-1-01abc', 'a.txt', 'a\n');
    await s.tick();
    expect(remoteRef(s.bare, 'refs/heads/fake/ao-1-01abc')).toBe(approved);

    s.as('fake:engineer').start('1', 'plan');
    s.as('fake:engineer').review(
      '1',
      `${approved.slice(0, 7)} on branch fake/ao-1-01abc: adds a.txt`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('1', 'approve', 'fine');
    await s.tick();
    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'log', '-1', '--format=%s', tip)).toBe('Change a.txt on fake/ao-1-01abc');
    // main has the merge only here: the normal sync does not push code, so the branch stays.
    await s.tick();
    expect(remoteRef(s.bare, 'refs/heads/fake/ao-1-01abc')).toBe(approved);
    const pending = JSON.parse(readFileSync(join(s.state, 'branches.json'), 'utf8')) as {
      deletes: unknown[];
    };
    expect(pending.deletes).toHaveLength(1);

    // Once the remote's main has the merge, the next round deletes the branch there.
    git(s.repo, 'push', '-q', 'origin', 'main');
    await s.tick();
    expect(remoteRef(s.bare, 'refs/heads/fake/ao-1-01abc')).toBeNull();
    // The local branch stays, and is not pushed again.
    expect(git(s.repo, 'rev-parse', 'refs/heads/fake/ao-1-01abc')).toBe(approved);
    await s.tick();
    expect(remoteRef(s.bare, 'refs/heads/fake/ao-1-01abc')).toBeNull();
  });
});
