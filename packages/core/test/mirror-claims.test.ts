import { describe, expect, it } from 'vitest';
import { Workspace } from '../src/index.js';
import { cloneOf, state, world, SCENARIO_TIMEOUT } from './mirror-world.js';

describe('Master Repo mirror: claims', { timeout: SCENARIO_TIMEOUT }, () => {
  it('carries a claim made in the Master Repo back to the project root', async () => {
    const w = world();
    w.m1('human:dawid').newTask({ title: 'pricing page', owner: '*:engineer' });
    await w.sync1();
    await w.sync2();
    w.m2('codex:engineer').claim('site/WEB-0001');
    await w.sync2();
    await w.sync1();
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
});
