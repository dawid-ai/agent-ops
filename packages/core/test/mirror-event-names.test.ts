import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mirrorPair, readMirrored, Root, syncRoot, Workspace } from '../src/index.js';
import { git } from './helpers.js';
import { cloneOf, world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: event names', { timeout: SCENARIO_TIMEOUT }, () => {
  it('never renames an event that came across, when the project remote gets events too', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'shared', owner: '*:engineer' });
    await w.sync1();
    await w.sync2();
    // A comment made in the hub is pushed there, then crosses into the project clone on machine
    // 1, which has not pushed it yet...
    w.m2('codex:qa').comment('site/WEB-0001', 'from the hub');
    await w.sync2();
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
    await w.sync1();
    await w.sync2();
    const copy = join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'events');
    expect(readdirSync(events).sort()).toEqual(readdirSync(copy).sort());
  });
});
