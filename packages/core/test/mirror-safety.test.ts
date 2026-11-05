import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserConfig } from '../src/index.js';
import { initRoot, mirrorPair, Root, syncAll, syncRoot, Workspace } from '../src/index.js';
import { git, gitRepo, tempDir } from './helpers.js';

function hosted(name: string, prefix: string, mirror = false): { remote: string; clone: string } {
  const remote = tempDir();
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const clone = gitRepo();
  initRoot(clone, { name, prefix, human: 'human:dawid' });
  if (mirror) {
    const file = join(clone, '.agent-ops', 'config.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}mirror: true\n`);
  }
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'remote', 'add', 'origin', remote);
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  return { remote, clone };
}

function cloneOf(remote: string): string {
  const dir = tempDir();
  git(dir, 'clone', '-q', remote, '.');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  return dir;
}

/** A machine with the project root and the Master Repo: syncs the way `ops sync` does. */
function machine(site: string, hub: string, block: number) {
  const env = { OPS_CONFIG: join(site, 'none.yml') } as NodeJS.ProcessEnv;
  const user: UserConfig = { roots: [site], master: hub, id_block: block };
  const ws = (actor: string) => new Workspace({ cwd: site, env, actor, user });
  const sync = () => syncAll(ws('human:dawid').roots, user, { pull: true, push: true });
  return { ws, sync };
}

describe('Master Repo mirror safety', () => {
  it('settles task.md edits that meet in git between two machines that both mirror', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const site3 = cloneOf(site.remote);
    const hub3 = cloneOf(hub.remote);
    const m1 = machine(site.clone, hub.clone, 0);
    const m3 = machine(site3, hub3, 2);
    m1.ws('human:dawid').newTask({ title: 'start' });
    m1.sync();
    m3.sync();
    const mine = join(site.clone, '.agent-ops', 'tasks', 'WEB-0001', 'task.md');
    const theirs = join(hub3, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'task.md');
    writeFileSync(
      mine,
      readFileSync(mine, 'utf8').replace('title: start', 'title: from the project'),
    );
    writeFileSync(
      theirs,
      readFileSync(theirs, 'utf8').replace('title: start', 'title: from the hub copy'),
    );
    m1.sync();
    // Before the fix, this sync stopped in git rebase.
    const res = m3.sync();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(/kept the pushed one/);
    expect(m3.ws('human:dawid').view('site/WEB-0001').meta.title).toBe('from the project');
    // The losing edit is saved, not lost.
    const dir = join(hub3, '.agent-ops', '.ops', 'conflicts');
    const saved = readdirSync(dir);
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(dir, saved[0]!), 'utf8')).toContain('from the hub copy');
  });

  it('never writes outside the Master Repo for an odd root name', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const cfg = join(site.clone, '.agent-ops', 'config.yml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('name: site', 'name: ../../escaped'));
    const res = mirrorPair(
      new Root(join(site.clone, '.agent-ops')),
      new Root(join(hub.clone, '.agent-ops')),
    );
    expect(res.notes.join('\n')).toMatch(/not mirrored/);
    expect(existsSync(join(hub.clone, 'escaped'))).toBe(false);
    expect(existsSync(join(hub.clone, '.agent-ops', 'escaped'))).toBe(false);
  });

  it('does not mirror while the Master Repo checkout is off its store branch', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const m = machine(site.clone, hub.clone, 0);
    m.sync();
    git(hub.clone, 'checkout', '-q', '-b', 'code');
    m.ws('human:dawid').newTask({ title: 'held' });
    const res = m.sync();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(
      /hub: not mirrored; code is checked out, but the store branch is main/,
    );
    expect(existsSync(join(hub.clone, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001'))).toBe(
      false,
    );
    expect(git(hub.clone, 'log', '--oneline', 'main..code')).toBe('');
  });

  it('never writes through a link in the Master Repo', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const outside = tempDir();
    symlinkSync(outside, join(hub.clone, '.agent-ops', 'mirrors'), 'junction');
    const res = mirrorPair(
      new Root(join(site.clone, '.agent-ops')),
      new Root(join(hub.clone, '.agent-ops')),
    );
    expect(res.notes.join('\n')).toMatch(/through a link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never writes mirror state through a linked .ops folder', () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const outside = tempDir();
    symlinkSync(outside, join(site.clone, '.agent-ops', '.ops'), 'junction');
    const res = mirrorPair(
      new Root(join(site.clone, '.agent-ops')),
      new Root(join(hub.clone, '.agent-ops')),
    );
    expect(res.notes.join('\n')).toMatch(/through a link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('keeps the name of an event that crossed from a repo without an upstream', () => {
    // The project starts local-only: its events cross as they are.
    const project = gitRepo();
    initRoot(project, { name: 'site', prefix: 'WEB', human: 'human:dawid' });
    const cfg = join(project, '.agent-ops', 'config.yml');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}mirror: true\n`);
    const hub = hosted('hub', 'HUB');
    const m = machine(project, hub.clone, 0);
    m.ws('human:dawid').newTask({ title: 'local' });
    m.sync();
    // A remote gets the task, but the project does not track it yet.
    const remote = tempDir();
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(project, 'push', '-q', remote, 'HEAD:main');
    m.ws('claude:engineer').comment('WEB-0001', 'crossed while local');
    m.sync();
    const events = join(project, '.agent-ops', 'tasks', 'WEB-0001', 'events');
    const crossed = readdirSync(events).find((n) => n.endsWith('-claude-engineer.md'))!;
    // Another clone pushes a newer event on the task; then the project starts tracking the remote.
    const other = cloneOf(remote);
    const env = { OPS_CONFIG: join(other, 'none.yml') } as NodeJS.ProcessEnv;
    new Workspace({ cwd: other, env, actor: 'codex:qa', user: {} }).comment('WEB-0001', 'newer');
    syncRoot(new Root(join(other, '.agent-ops')), {}, { pull: true, push: true });
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'fetch', '-q', 'origin');
    git(project, 'branch', '-q', '--set-upstream-to=origin/main');
    m.sync();
    m.sync();
    // The crossed event kept its name, so neither side holds it twice.
    expect(readdirSync(events)).toContain(crossed);
    const copy = join(hub.clone, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'events');
    expect(readdirSync(events).sort()).toEqual(readdirSync(copy).sort());
    expect(readdirSync(events).filter((n) => n.endsWith('-claude-engineer.md'))).toHaveLength(1);
  });
});
