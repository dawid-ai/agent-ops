import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initRoot, Root, syncRoot, Workspace } from '../src/index.js';
import { git, gitRepo, tempDir } from './helpers.js';
import { cloneOf, hosted, machine, SCENARIO_TIMEOUT, turn } from './mirror-world.js';

describe('Master Repo mirror safety: no upstream', { timeout: SCENARIO_TIMEOUT }, () => {
  it('keeps the name of an event that crossed from a repo without an upstream', async () => {
    // The project starts local-only: its events cross as they are.
    const project = gitRepo();
    initRoot(project, { name: 'site', prefix: 'WEB', human: 'human:dawid' });
    const cfg = join(project, '.agent-ops', 'config.yml');
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}mirror: true\n`);
    const hub = hosted('hub', 'HUB');
    const m = machine(project, hub.clone, 0);
    m.ws('human:dawid').newTask({ title: 'local' });
    await m.sync();
    // A remote gets the task, but the project does not track it yet.
    const remote = tempDir();
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    git(project, 'push', '-q', remote, 'HEAD:main');
    m.ws('claude:engineer').comment('WEB-0001', 'crossed while local');
    await m.sync();
    const events = join(project, '.agent-ops', 'tasks', 'WEB-0001', 'events');
    const crossed = readdirSync(events).find((n) => n.endsWith('-claude-engineer.md'))!;
    // Another clone pushes a newer event on the task; then the project starts tracking the remote.
    const other = cloneOf(remote);
    const env = { OPS_CONFIG: join(other, 'none.yml') } as NodeJS.ProcessEnv;
    new Workspace({ cwd: other, env, actor: 'codex:qa', user: {} }).comment('WEB-0001', 'newer');
    await turn();
    syncRoot(new Root(join(other, '.agent-ops')), {}, { pull: true, push: true });
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'fetch', '-q', 'origin');
    git(project, 'branch', '-q', '--set-upstream-to=origin/main');
    await m.sync();
    await m.sync();
    // The crossed event kept its name, so neither side holds it twice.
    expect(readdirSync(events)).toContain(crossed);
    const copy = join(hub.clone, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'events');
    expect(readdirSync(events).sort()).toEqual(readdirSync(copy).sort());
    expect(readdirSync(events).filter((n) => n.endsWith('-claude-engineer.md'))).toHaveLength(1);
  });
});
