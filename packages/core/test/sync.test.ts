import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRoot, Root, syncRoot, Workspace } from '../src/index.js';
import { fakeToken, git, gitRepo, tempDir } from './helpers.js';

function machines(opts: { policy?: string } = {}) {
  const remote = tempDir();
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const a = gitRepo();
  initRoot(a, { name: 'shared', human: 'human:dawid' });
  if (opts.policy) {
    const file = join(a, '.agent-ops', 'config.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('policy: checkpoint', `policy: ${opts.policy}`),
    );
  }
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'init');
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const b = tempDir();
  git(b, 'clone', '-q', remote, '.');
  git(b, 'config', 'user.name', 'Test');
  git(b, 'config', 'user.email', 'test@example.invalid');
  const env = { OPS_CONFIG: join(a, 'none.yml') } as NodeJS.ProcessEnv;
  const ws = (cwd: string, actor: string, block = 0, now?: () => number) =>
    new Workspace({ cwd, env, actor, now, user: { id_block: block, machine: `m${block}` } });
  const ra = new Root(join(a, '.agent-ops'));
  const rb = new Root(join(b, '.agent-ops'));
  return { remote, a, b, ws, ra, rb };
}

/** The parts of a task's state that every clone must agree on. */
function agreed(v: { status: string; claimedBy: string | null; claimToken: string | null }) {
  const { status, claimedBy, claimToken } = v;
  return { status, claimedBy, claimToken };
}

describe('sync', () => {
  it('moves tasks between two machines without conflicts', () => {
    const { a, b, ws } = machines();
    ws(a, 'human:dawid', 0).newTask({ title: 'from a' });
    ws(b, 'human:dawid', 1).newTask({ title: 'from b' });
    const ra = new Root(join(a, '.agent-ops'));
    const rb = new Root(join(b, '.agent-ops'));
    expect(syncRoot(ra, { machine: 'a' })).toMatchObject({ committed: 1, pushed: true });
    expect(syncRoot(rb, { machine: 'b' })).toMatchObject({ pulled: true, pushed: true });
    syncRoot(ra, {});
    const titles = (cwd: string) =>
      ws(cwd, 'human:dawid')
        .list()
        .map((v) => v.meta.title)
        .sort();
    expect(titles(a)).toEqual(['from a', 'from b']);
    expect(titles(b)).toEqual(['from a', 'from b']);
    expect(git(a, 'log', '-2', '--format=%s').split('\n').sort()).toEqual([
      '',
      'ops: 1 change(s) from a',
      'ops: 1 change(s) from b',
    ]);
    expect(git(a, 'log', '-1', '--format=%B')).not.toMatch(/Co-Authored-By/i);
  });

  it('merges events written on both machines for the same task', () => {
    const { a, b, ws } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    const ra = new Root(join(a, '.agent-ops'));
    const rb = new Root(join(b, '.agent-ops'));
    syncRoot(ra, {});
    syncRoot(rb, {});
    ws(a, 'human:dawid').comment('1', 'from a');
    ws(b, 'human:dawid', 1).comment('1', 'from b');
    syncRoot(ra, {});
    syncRoot(rb, {});
    syncRoot(ra, {});
    expect(
      ws(a, 'human:dawid')
        .showEvents('1')
        .events.map((e) => e.body.trim())
        .sort(),
    ).toEqual(['from a', 'from b']);
  });

  it('lets the claim pushed first win, even when the other clone claimed earlier', () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    syncRoot(ra, {});
    syncRoot(rb, {});
    // Both clones run claude:engineer. b's clock is a minute behind, so its events carry older
    // ids; a pushes first.
    const behind = () => Date.now() - 60_000;
    const bEng = ws(b, 'claude:engineer', 1, behind);
    const bToken = bEng.start('1', 'b plan').events.find((e) => e.type === 'claim')!.token;
    bEng.progress('1', 'b works');
    const aRes = ws(a, 'claude:engineer').start('1', 'a plan');
    const aToken = aRes.events.find((e) => e.type === 'claim')!.token;
    expect(aToken).not.toBe(bToken);
    expect(syncRoot(ra, {}).pushed).toBe(true);

    const res = syncRoot(rb, {});
    expect(res.pushed).toBe(true);
    expect(res.reordered).toBe(3);
    expect(res.lost).toEqual([
      expect.objectContaining({
        task: 'T-0001',
        actor: 'claude:engineer',
        winner: 'claude:engineer',
      }),
    ]);
    // The loser has the same agent id, but its clone's claim lost: it cannot start, report on or
    // release the winner's claim.
    expect(() => bEng.release('1', 'lost it')).toThrow(/claim from another clone/);
    expect(() => bEng.progress('1', 'still here')).toThrow(/claim from another clone/);
    ws(a, 'claude:engineer').progress('1', 'a works');
    syncRoot(ra, {});
    syncRoot(rb, {});
    // The loser is still the owner, so it may checkpoint; that must not renew the winner's lease.
    const leaseBefore = ws(a, 'human:dawid').view('1').leaseUntil;
    ws(b, 'claude:engineer', 1, () => Date.now() + 3600_000).checkpoint('1', 'notes from b');
    syncRoot(rb, {});
    syncRoot(ra, {});
    expect(ws(a, 'human:dawid').view('1').leaseUntil).toBe(leaseBefore);

    const va = ws(a, 'human:dawid').view('1');
    const vb = ws(b, 'human:dawid').view('1');
    expect(agreed(va)).toEqual({
      status: 'in-progress',
      claimedBy: 'claude:engineer',
      claimToken: aToken,
    });
    expect(agreed(vb)).toEqual(agreed(va));
    expect(vb.leaseUntil).toBe(va.leaseUntil);
    expect(vb.lostClaims).toEqual(va.lostClaims);
    expect(va.lostClaims).toHaveLength(2);
    const order = ws(a, 'human:dawid')
      .showEvents('1')
      .events.filter((e) => e.type === 'claim')
      .map((e) => e.token);
    expect(order).toEqual([aToken, bToken]);
  });

  it('keeps a local claim made after the remote claim was released', () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    syncRoot(ra, {});
    syncRoot(rb, {});
    const aEng = ws(a, 'claude:engineer');
    aEng.claim('1');
    aEng.release('1', 'not mine after all');
    syncRoot(ra, {});
    const bToken = ws(b, 'claude:engineer', 1, () => Date.now() - 60_000)
      .claim('1')
      .events.find((e) => e.type === 'claim')!.token;
    expect(syncRoot(rb, {}).lost).toEqual([]);
    syncRoot(ra, {});
    for (const cwd of [a, b]) {
      expect(agreed(ws(cwd, 'human:dawid').view('1'))).toEqual({
        status: 'claimed',
        claimedBy: 'claude:engineer',
        claimToken: bToken,
      });
    }
  });

  it('pulls and orders again when a push is rejected', () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    syncRoot(ra, {});
    syncRoot(rb, {});
    // b writes first, so its event has the older id, but a pushes first.
    ws(b, 'human:dawid', 1).comment('1', 'from b');
    ws(a, 'human:dawid').comment('1', 'from a');
    syncRoot(ra, {});
    const res = syncRoot(rb, {}, { pull: false, push: true });
    expect(res).toMatchObject({ pulled: true, pushed: true, reordered: 1 });
    syncRoot(ra, {});
    expect(
      ws(a, 'human:dawid')
        .showEvents('1')
        .events.map((e) => e.body.trim()),
    ).toEqual(['from a', 'from b']);
  });

  it('reports a claim as lost only when it lost in the final state of the sync', () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    syncRoot(ra, {});
    syncRoot(rb, {});
    const aEng = ws(a, 'claude:engineer');
    aEng.claim('1');
    syncRoot(ra, {});
    // a releases but does not push yet; b's pre-push hook pushes it, so b's first pull sees only
    // a's claim and b's push is rejected once.
    aEng.release('1', 'done with it');
    syncRoot(ra, {}, { pull: false, push: false });
    const marker = join(b, 'hook-ran');
    writeFileSync(
      join(b, '.git', 'hooks', 'pre-push'),
      [
        '#!/bin/sh',
        `[ -f "${marker.split('\\').join('/')}" ] && exit 0`,
        `touch "${marker.split('\\').join('/')}"`,
        'unset $(git rev-parse --local-env-vars)',
        `git -C "${a.split('\\').join('/')}" push -q`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const bToken = ws(b, 'claude:engineer', 1)
      .claim('1')
      .events.find((e) => e.type === 'claim')!.token;
    const res = syncRoot(rb, {});
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(res.pushed).toBe(true);
    expect(res.lost).toEqual([]);
    syncRoot(ra, {});
    for (const cwd of [a, b]) {
      expect(agreed(ws(cwd, 'human:dawid').view('1'))).toEqual({
        status: 'claimed',
        claimedBy: 'claude:engineer',
        claimToken: bToken,
      });
    }
  });

  it('pushes a claim at once under coordinated sync and tells the loser', () => {
    const { remote, a, b, ws, ra, rb } = machines({ policy: 'coordinated' });
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    syncRoot(ra, {});
    syncRoot(rb, {});
    const before = git(remote, 'rev-parse', 'main');
    const aToken = ws(a, 'claude:engineer')
      .claim('1')
      .events.find((e) => e.type === 'claim')!.token;
    expect(git(remote, 'rev-parse', 'main')).not.toBe(before);
    expect(() => ws(b, 'claude:engineer', 1, () => Date.now() - 60_000).claim('1')).toThrow(
      /lost the claim on T-0001 to claude:engineer/,
    );
    expect(() => ws(b, 'claude:engineer', 1).start('1', 'plan')).toThrow(
      /claim from another clone/,
    );
    syncRoot(ra, {});
    for (const cwd of [a, b]) {
      expect(ws(cwd, 'human:dawid').view('1').claimToken).toBe(aToken);
    }
  });

  it('keeps a coordinated claim locally when the push fails', () => {
    const { a, ws, ra } = machines({ policy: 'coordinated' });
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    syncRoot(ra, {});
    git(a, 'remote', 'set-url', 'origin', join(a, 'no-such-remote'));
    const res = ws(a, 'claude:engineer').claim('1');
    expect(res.view.claimedBy).toBe('claude:engineer');
    expect(res.notes?.[0]).toMatch(/^not synced yet: .*the next sync sends it$/);
  });

  it('refuses to commit a leaked secret', () => {
    const { a, ws } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    writeFileSync(join(a, '.agent-ops', 'kb', 'note.md'), `token ${fakeToken()}\n`);
    expect(() => syncRoot(new Root(join(a, '.agent-ops')), {})).toThrow(/leak check failed/);
    expect(git(a, 'status', '--porcelain')).toContain('kb/note.md');
  });

  it('commits only the root and holds back pushes that carry code', () => {
    const { a, ws } = machines();
    writeFileSync(join(a, 'code.ts'), 'export {};\n');
    ws(a, 'human:dawid').newTask({ title: 't' });
    const ra = new Root(join(a, '.agent-ops'));
    expect(syncRoot(ra, {}).pushed).toBe(true);
    expect(git(a, 'status', '--porcelain')).toContain('code.ts');
    git(a, 'add', 'code.ts');
    git(a, 'commit', '-q', '-m', 'code');
    ws(a, 'human:dawid').newTask({ title: 'u' });
    const res = syncRoot(ra, {});
    expect(res.pushed).toBe(false);
    expect(res.notes.join()).toMatch(/outside \.agent-ops/);
    expect(syncRoot(ra, {}, { allPaths: true }).pushed).toBe(true);
  });

  it('follows the policy on --auto', () => {
    const { a, ws } = machines();
    const ra = new Root(join(a, '.agent-ops'));
    ws(a, 'human:dawid').newTask({ title: 't' });
    const t = Date.now();
    expect(syncRoot(ra, {}, { auto: true, now: t })).toMatchObject({ pulled: true, pushed: true });
    ws(a, 'human:dawid').newTask({ title: 'u' });
    expect(syncRoot(ra, {}, { auto: true, now: t + 60_000 })).toMatchObject({
      committed: 1,
      pulled: false,
      pushed: false,
    });
    expect(syncRoot(ra, {}, { auto: true, sessionEnd: true, now: t + 120_000 }).pushed).toBe(true);
  });

  it('commits only on the store branch and keeps held files for the next sync there', () => {
    const { a, ws, ra } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    expect(syncRoot(ra, {}).committed).toBe(1);
    expect(JSON.parse(readFileSync(join(ra.opsDir, 'sync.json'), 'utf8')).branch).toBe('main');

    // A code branch checked out in the data root's checkout, as in AO-0133.
    git(a, 'checkout', '-q', '-b', 'code');
    ws(a, 'human:dawid').comment('1', 'written while code is checked out');
    const codeHead = git(a, 'rev-parse', 'code');
    const res = syncRoot(ra, {});
    expect(res).toMatchObject({ committed: 0, pulled: false, pushed: false });
    expect(res.notes.join()).toMatch(/code is checked out, but the store branch is main/);
    expect(git(a, 'rev-parse', 'code')).toBe(codeHead);

    git(a, 'checkout', '-q', 'main');
    expect(
      ws(a, 'human:dawid')
        .showEvents('1')
        .events.some((e) => e.body.trim() === 'written while code is checked out'),
    ).toBe(true);
    expect(syncRoot(ra, {})).toMatchObject({ committed: 1, pushed: true });
    expect(git(a, 'status', '--porcelain', '--', '.agent-ops')).toBe('');
  });

  it('takes the store branch from sync.branch in config.yml over the learned one', () => {
    const { a, ws, ra } = machines();
    syncRoot(ra, {});
    const file = join(a, '.agent-ops', 'config.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'policy: checkpoint',
        'policy: checkpoint\n  branch: store',
      ),
    );
    ws(a, 'human:dawid').newTask({ title: 't' });
    const res = syncRoot(new Root(join(a, '.agent-ops')), {});
    expect(res.committed).toBe(0);
    expect(res.notes.join()).toMatch(/store branch is store \(from sync\.branch in config\.yml\)/);
  });

  it('does not learn a code branch on the first sync after an upgrade', () => {
    const { a, ws, ra } = machines();
    // A stamp written before store branches existed: no branch in it.
    mkdirSync(ra.opsDir, { recursive: true });
    writeFileSync(join(ra.opsDir, 'sync.json'), JSON.stringify({ lastPull: 1, lastPush: 1 }));
    git(a, 'checkout', '-q', '-b', 'code');
    ws(a, 'human:dawid').newTask({ title: 'written while code is checked out' });
    const codeHead = git(a, 'rev-parse', 'code');
    const res = syncRoot(ra, {});
    expect(res).toMatchObject({ committed: 0, pulled: false, pushed: false });
    expect(res.notes.join()).toMatch(/no store branch is known yet and main also holds/);
    expect(git(a, 'rev-parse', 'code')).toBe(codeHead);
    expect(JSON.parse(readFileSync(join(ra.opsDir, 'sync.json'), 'utf8')).branch).toBeUndefined();

    // A code commit outside the store does not make the code branch the store branch.
    writeFileSync(join(a, 'code.txt'), 'x');
    git(a, 'add', 'code.txt');
    git(a, 'commit', '-q', '-m', 'code change');
    expect(syncRoot(ra, {}).committed).toBe(0);

    git(a, 'checkout', '-q', 'main');
    expect(syncRoot(ra, {})).toMatchObject({ committed: 1, pushed: true });
    expect(JSON.parse(readFileSync(join(ra.opsDir, 'sync.json'), 'utf8')).branch).toBe('main');
    git(a, 'checkout', '-q', 'code');
    ws(a, 'human:dawid').newTask({ title: 'later' });
    expect(syncRoot(ra, {}).notes.join()).toMatch(
      /store branch is main \(from \.ops\/sync\.json\)/,
    );
  });

  it('holds the first sync on a branch without the newest store commit', () => {
    const { a, ws, ra } = machines();
    git(a, 'branch', 'code');
    ws(a, 'human:dawid').newTask({ title: 't' });
    git(a, 'add', '-A');
    git(a, 'commit', '-q', '-m', 'ops: 1 change(s)');
    git(a, 'checkout', '-q', 'code');
    ws(a, 'human:dawid').newTask({ title: 'u' });
    const res = syncRoot(ra, {});
    expect(res.committed).toBe(0);
    expect(res.notes.join()).toMatch(/the newest store commit is on main, not code/);
  });

  it('does not commit on a detached HEAD', () => {
    const { a, ws, ra } = machines();
    syncRoot(ra, {});
    git(a, 'checkout', '-q', '--detach');
    ws(a, 'human:dawid').newTask({ title: 't' });
    const res = syncRoot(ra, {});
    expect(res.committed).toBe(0);
    expect(res.notes.join()).toMatch(/HEAD is detached; check out main/);
  });

  it('notes a missing upstream instead of failing', () => {
    const repo = gitRepo();
    initRoot(repo, { name: 'solo' });
    const res = syncRoot(new Root(join(repo, '.agent-ops')), {});
    expect(res.committed).toBeGreaterThan(0);
    expect(res.notes).toEqual(['no upstream branch; skipped pull and push']);
  });
});
