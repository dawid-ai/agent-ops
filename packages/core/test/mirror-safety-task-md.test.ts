import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cloneOf, hosted, machine, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror safety: task.md', { timeout: SCENARIO_TIMEOUT }, () => {
  it('settles task.md edits that meet in git between two machines that both mirror', async () => {
    const site = hosted('site', 'WEB', true);
    const hub = hosted('hub', 'HUB');
    const site3 = cloneOf(site.remote);
    const hub3 = cloneOf(hub.remote);
    const m1 = machine(site.clone, hub.clone, 0);
    const m3 = machine(site3, hub3, 2);
    m1.ws('human:dawid').newTask({ title: 'start' });
    await m1.sync();
    await m3.sync();
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
    await m1.sync();
    // Before the fix, this sync stopped in git rebase.
    const res = await m3.sync();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(/kept the pushed one/);
    expect(m3.ws('human:dawid').view('site/WEB-0001').meta.title).toBe('from the project');
    // The losing edit is saved, not lost.
    const dir = join(hub3, '.agent-ops', '.ops', 'conflicts');
    const saved = readdirSync(dir);
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(dir, saved[0]!), 'utf8')).toContain('from the hub copy');
  });
});
