import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: task.md', { timeout: SCENARIO_TIMEOUT }, () => {
  it('keeps task.md edits from the side that changed', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'old title' });
    await w.sync1();
    await w.sync2();
    const copy = join(w.hub2, '.agent-ops', 'mirrors', 'site', 'tasks', 'WEB-0001', 'task.md');
    writeFileSync(
      copy,
      readFileSync(copy, 'utf8').replace('title: old title', 'title: from the hub'),
    );
    await w.sync2();
    await w.sync1();
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
    await w.sync2();
    const res = await w.sync1();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(/changed on both sides/);
    await w.sync2();
    expect(w.m2('human:dawid').view('site/WEB-0001').meta.title).toBe('project');
  });
});
