import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserConfig } from '../src/index.js';
import {
  initRoot,
  mirrorPair,
  readMirrored,
  Root,
  syncAll,
  syncRoot,
  Workspace,
} from '../src/index.js';
import { git, gitRepo, tempDir } from './helpers.js';

/** A bare remote with one pushed clone holding a data root. */
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

/**
 * Machine 1 has the project repo and the Master Repo; machine 2 has only the Master Repo. Both
 * run every sync through syncAll, as `ops sync` and opsd do.
 */
function world() {
  const site = hosted('site', 'WEB', true);
  const hub = hosted('hub', 'HUB');
  const hub2 = cloneOf(hub.remote);
  const env = { OPS_CONFIG: join(site.clone, 'none.yml') } as NodeJS.ProcessEnv;
  const user1: UserConfig = { roots: [site.clone], master: hub.clone, id_block: 0, machine: 'pc' };
  const user2: UserConfig = { master: hub2, id_block: 1, machine: 'laptop' };
  const m1 = (actor: string, now?: () => number) =>
    new Workspace({ cwd: site.clone, env, actor, user: user1, now });
  const m2 = (actor: string, now?: () => number) =>
    new Workspace({ cwd: hub2, env, actor, user: user2, now });
  const sync1 = () => syncAll(m1('human:dawid').roots, user1, { pull: true, push: true });
  const sync2 = () => syncAll(m2('human:dawid').roots, user2, { pull: true, push: true });
  return { site, hub, hub2, m1, m2, sync1, sync2, env, user1, user2 };
}

const state = (ws: Workspace, ref: string) => {
  const v = ws.view(ref);
  return {
    status: v.status,
    claimedBy: v.claimedBy,
    claimToken: v.claimToken,
    title: v.meta.title,
  };
};

describe('Master Repo mirror', () => {
  it('shows a mirrored project root in the Master Repo, on a machine without the project', () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'pricing page', owner: 'claude:engineer' });
    w.m1('claude:engineer').post('general', 'hello from the project');
    w.m1('claude:engineer').learn({ topic: 'css', title: 'Grid gaps', body: 'Use gap.' });
    w.sync1();
    // Machine 1 sees the project root once: its own copy in the Master Repo stays hidden.
    expect(
      w
        .m1('human:dawid')
        .roots.map((r) => r.name)
        .sort(),
    ).toEqual(['hub', 'site']);
    w.sync2();
    const ws2 = w.m2('human:dawid');
    expect(ws2.roots.map((r) => r.name).sort()).toEqual(['hub', 'site']);
    expect(ws2.roots.find((r) => r.name === 'site')!.isMirror).toBe(true);
    expect(ws2.list().map((v) => `${v.root}/${v.meta.id} ${v.meta.title}`)).toEqual([
      'site/WEB-0001 pricing page',
    ]);
    expect(ws2.kb(['gap']).map((h) => h.note.ref)).toEqual(['css/grid-gaps']);
    expect(ws2.channel('general').map((m) => m.body)).toContain('hello from the project');
  });

  it('carries attached images both ways', () => {
    const w = world();
    const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, n]);
    w.m1('human:dawid').newTask({ title: 'pricing page' });
    const fromProject = w.m1('human:dawid').attach(png(1), { task: 'site/WEB-0001' });
    w.sync1();
    w.sync2();
    const there = w.m2('human:dawid').attachment(fromProject.name);
    expect(there.root).toBe('site');
    expect(readFileSync(there.file)).toEqual(png(1));

    const fromMaster = w.m2('human:dawid').attach(png(2), { task: 'site/WEB-0001' });
    w.sync2();
    w.sync1();
    const back = w.m1('human:dawid').attachment(fromMaster.name);
    expect(back.file.startsWith(join(w.site.clone, '.agent-ops'))).toBe(true);
    expect(readFileSync(back.file)).toEqual(png(2));
  });

  it('carries repeats both ways, with edits, pauses and deletes', () => {
    const w = world();
    const now = () => new Date(2026, 10, 3, 12).getTime();
    w.m1('human:dawid').saveRepeat({
      name: 'report',
      title: 'Daily report',
      start: '2026-11-01 09:00',
      repeat: 'daily',
    });
    w.sync1();
    w.sync2();
    // A machine with only the Master Repo sees the repeat and fires it.
    const ws2 = w.m2('human:dawid', now);
    expect(ws2.repeats().map((r) => `${r.root}/${r.meta.name}`)).toEqual(['site/report']);
    expect(ws2.fireRepeats().map((f) => `${f.root} ${f.slot}`)).toEqual(['site 2026-11-03T09:00']);

    // A pause in the Master Repo reaches the project root.
    w.m2('human:dawid').setRepeatPaused('site/report', true);
    w.sync2();
    w.sync1();
    const ws1 = w.m1('human:dawid', now);
    expect(ws1.repeatView('site/report').meta.paused).toBe(true);
    // The task it fired came across too: the project root does not fire that slot again.
    ws1.setRepeatPaused('site/report', false);
    expect(ws1.fireRepeats()).toEqual([]);

    // An edit in the project root reaches the Master Repo and is not undone by the old copy.
    w.m1('human:dawid').saveRepeat(
      { name: 'report', title: 'Daily report v2', start: '2026-11-01 09:00', repeat: 'daily' },
      { replace: true },
    );
    w.sync1();
    w.sync2();
    expect(w.m2('human:dawid').repeatView('site/report').meta.title).toBe('Daily report v2');
    expect(w.m1('human:dawid').repeatView('site/report').meta.title).toBe('Daily report v2');

    // A delete on either side removes it on both.
    w.m2('human:dawid').deleteRepeat('site/report');
    w.sync2();
    w.sync1();
    expect(w.m1('human:dawid').repeats()).toEqual([]);
    w.sync1();
    w.sync2();
    expect(w.m2('human:dawid').repeats()).toEqual([]);
  });

  it('carries a claim made in the Master Repo back to the project root', () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'pricing page', owner: '*:engineer' });
    w.sync1();
    w.sync2();
    w.m2('codex:engineer').claim('site/WEB-0001');
    w.sync2();
    w.sync1();
    const here = state(w.m1('human:dawid'), 'site/WEB-0001');
    expect(here).toMatchObject({ status: 'claimed', claimedBy: 'codex:engineer' });
    // The project's remote has it too: a fresh clone of the project sees the claim.
    const other = cloneOf(w.site.remote);
    const fresh = new Workspace({ cwd: other, env: w.env, actor: 'human:dawid', user: {} });
    expect(state(fresh, 'WEB-0001')).toEqual(here);
    // A claim on this clone of the project would now lose: the task is held.
    expect(() => w.m1('claude:engineer').claim('site/WEB-0001')).toThrow(
      /claimed by codex:engineer/,
    );
  });

  it('settles a claim race between the project root and the Master Repo the same way on both', () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'pricing page', owner: '*:engineer' });
    w.sync1();
    w.sync2();
    // Both machines claim before either sees the other.
    w.m1('claude:engineer').claim('site/WEB-0001');
    w.m2('codex:engineer').claim('site/WEB-0001');
    w.sync2();
    w.sync1();
    w.sync2();
    w.sync1();
    const one = state(w.m1('human:dawid'), 'site/WEB-0001');
    const two = state(w.m2('human:dawid'), 'site/WEB-0001');
    expect(one).toEqual(two);
    expect(['claude:engineer', 'codex:engineer']).toContain(one.claimedBy);
    // Both sides hold the same event files.
    const names = (dir: string) => readdirSync(dir).sort();
    expect(names(join(w.site.clone, '.agent-ops', 'tasks', 'WEB-0001', 'events'))).toEqual(
      names(join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'events')),
    );
    // The losing side learns it lost.
    const loserWs =
      one.claimedBy === 'claude:engineer' ? w.m2('codex:engineer') : w.m1('claude:engineer');
    expect(loserWs.holdsClaim('site/WEB-0001')).toBe(false);
  });

  it('keeps task.md edits from the side that changed, and archive moves', () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'old title' });
    w.sync1();
    w.sync2();
    const copy = join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'task.md');
    writeFileSync(
      copy,
      readFileSync(copy, 'utf8').replace('title: old title', 'title: from the hub'),
    );
    w.sync2();
    w.sync1();
    expect(w.m1('human:dawid').view('site/WEB-0001').meta.title).toBe('from the hub');

    // Both sides change: the project root wins, with a note.
    const mine = join(w.site.clone, '.agent-ops', 'tasks', 'WEB-0001', 'task.md');
    writeFileSync(
      mine,
      readFileSync(mine, 'utf8').replace('title: from the hub', 'title: project'),
    );
    writeFileSync(
      copy,
      readFileSync(copy, 'utf8').replace('title: from the hub', 'title: hub again'),
    );
    w.sync2();
    const res = w.sync1();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(/changed on both sides/);
    w.sync2();
    expect(w.m2('human:dawid').view('site/WEB-0001').meta.title).toBe('project');

    w.m1('human:dawid').done('site/WEB-0001');
    new Root(join(w.site.clone, '.agent-ops')).archiveTask('WEB-0001');
    w.sync1();
    w.sync2();
    expect(
      existsSync(join(w.hub2, '.agent-ops', 'mirrors', 'site', 'archive', 'tasks', 'WEB-0001')),
    ).toBe(true);
    expect(existsSync(join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001'))).toBe(
      false,
    );
  });

  it('reports two different tasks with one id and merges neither', () => {
    const w = world();
    w.sync1();
    w.sync2();
    // Same id block on both machines, so both pick WEB-0001.
    const sameBlock = new Workspace({
      cwd: w.hub2,
      env: w.env,
      actor: 'human:dawid',
      user: { ...w.user2, id_block: 0 },
    });
    sameBlock.newTask(
      { title: 'made in the hub' },
      sameBlock.roots.find((r) => r.name === 'site'),
    );
    w.m1('human:dawid').newTask({ title: 'made in the project' });
    w.sync2();
    const res = w.sync1();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(/different tasks with one id/);
    expect(w.m1('human:dawid').view('site/WEB-0001').meta.title).toBe('made in the project');
  });

  it('never renames an event that came across, when the project remote gets events too', () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'shared', owner: '*:engineer' });
    w.sync1();
    w.sync2();
    // A comment made in the hub is pushed there, then crosses into the project clone on machine
    // 1, which has not pushed it yet...
    w.m2('codex:qa').comment('site/WEB-0001', 'from the hub');
    w.sync2();
    const project = new Root(join(w.site.clone, '.agent-ops'));
    const hub = new Root(join(w.hub.clone, '.agent-ops'));
    git(w.hub.clone, 'pull', '-q');
    expect(mirrorPair(project, hub).toProject).toBeGreaterThan(0);
    const events = join(w.site.clone, '.agent-ops', 'tasks', 'WEB-0001', 'events');
    const crossed = readdirSync(events).find((n) => n.endsWith('-codex-qa.md'))!;
    // ...while another clone of the project pushes a newer event on the same task.
    const p2 = cloneOf(w.site.remote);
    new Workspace({ cwd: p2, env: w.env, actor: 'claude:qa', user: {} }).comment(
      'WEB-0001',
      'from p2',
    );
    syncRoot(new Root(join(p2, '.agent-ops')), {}, { pull: true, push: true });
    // Machine 1's sync pulls the newer event: its own unpushed events would move after it, but
    // the one that came across keeps its name, as it has in the Master Repo.
    syncRoot(project, w.user1, { pull: true, push: true });
    expect(readdirSync(events)).toContain(crossed);
    // Once the project remote has it, the pin is dropped.
    expect([...readMirrored(project)]).toEqual([]);
    w.sync1();
    w.sync2();
    const copy = join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'events');
    expect(readdirSync(events).sort()).toEqual(readdirSync(copy).sort());
  });
});
