import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/index.js';
import { world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: task ids', { timeout: SCENARIO_TIMEOUT }, () => {
  it('reports two different tasks with one id and merges neither', async () => {
    const w = world();
    await w.sync1();
    await w.sync2();
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
    await w.sync2();
    const res = await w.sync1();
    expect(res.flatMap((r) => r.result.notes).join('\n')).toMatch(/different tasks with one id/);
    expect(w.m1('human:dawid').view('site/WEB-0001').meta.title).toBe('made in the project');
  });
});
